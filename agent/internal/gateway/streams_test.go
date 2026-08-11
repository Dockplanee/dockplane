package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/protocol"
)

/*
The stream lifecycle on the agent side.

A stream is a request that answers over time, so the questions are different
from an ordinary capability: does it announce itself, does a cancel reach it,
does it end when its connection does, and does anything about the content reach
the agent's own log.
*/

// recorder captures what the agent wrote instead of sending it to a server.
type recorder struct {
	mu       sync.Mutex
	messages []map[string]any
	fail     bool
}

func (r *recorder) write(message any) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.fail {
		return context.Canceled
	}

	encoded, err := json.Marshal(message)

	if err != nil {
		return err
	}

	var decoded map[string]any

	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return err
	}

	r.messages = append(r.messages, decoded)

	return nil
}

func (r *recorder) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()

	types := make([]string, 0, len(r.messages))

	for _, message := range r.messages {
		types = append(types, message["type"].(string))
	}

	return types
}

func (r *recorder) find(messageType string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, message := range r.messages {
		if message["type"] == messageType {
			return message
		}
	}

	return nil
}

// streamingClient builds a client whose writes are captured and whose only
// capability emits what the test decides.
func streamingClient(
	t *testing.T,
	handler capability.StreamHandler,
	logs *bytes.Buffer,
) (*Client, *recorder) {
	t.Helper()

	registry := capability.New()
	registry.RegisterStream(capability.StreamDefinition{
		Name:        capability.ContainerLogs,
		MaxDuration: 5 * time.Second,
		Handler:     handler,
	})

	logger := slog.New(slog.DiscardHandler)

	if logs != nil {
		logger = slog.New(slog.NewJSONHandler(logs, nil))
	}

	client := New(Options{Registry: registry, Logger: logger})
	sink := &recorder{}
	client.write = sink.write

	return client, sink
}

func logRequest(id, streamID string) *protocol.ServerMessage {
	return &protocol.ServerMessage{
		Type:            protocol.TypeRequest,
		ProtocolVersion: protocol.Version,
		ID:              id,
		StreamID:        streamID,
		Capability:      capability.ContainerLogs,
		IssuedAt:        time.Now().Format(time.RFC3339),
		ExpiresAt:       time.Now().Add(time.Minute).Format(time.RFC3339),
		Payload:         json.RawMessage(`{"containerId":"aaa111","stdout":true}`),
	}
}

func TestAStreamAnnouncesItselfAndEnds(t *testing.T) {
	client, sink := streamingClient(t, func(
		_ context.Context, _ json.RawMessage, emit func(capability.Chunk) error,
	) error {
		return emit(capability.Chunk{Payload: map[string]any{"lines": []any{}}})
	}, nil)

	client.handleStream(context.Background(), logRequest("req-1", "stream-1"))

	want := []string{protocol.TypeStreamStarted, protocol.TypeStreamChunk, protocol.TypeStreamEnd}

	if got := sink.types(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("messages = %v, want %v", got, want)
	}

	if sink.find(protocol.TypeStreamStarted)["streamId"] != "stream-1" {
		t.Error("the stream did not echo the identifier the server assigned")
	}

	if sink.find(protocol.TypeStreamEnd)["reason"] != protocol.StreamCompleted {
		t.Errorf("reason = %v, want completed", sink.find(protocol.TypeStreamEnd)["reason"])
	}
}

/*
A stream carries a server-assigned identifier or it does not run.

The identifier is how the server binds what follows to the stream it opened. An
agent that invented one could deliver chunks the server could not place.
*/
func TestAStreamWithoutAnIdentifierIsRefused(t *testing.T) {
	client, sink := streamingClient(t, func(
		context.Context, json.RawMessage, func(capability.Chunk) error,
	) error {
		t.Error("the handler ran for a request with no stream identifier")
		return nil
	}, nil)

	client.handleStream(context.Background(), logRequest("req-1", ""))

	if sink.find(protocol.TypeStreamStarted) != nil {
		t.Error("a stream was started without an identifier")
	}
}

func TestCancelEndsTheStreamItNames(t *testing.T) {
	running := make(chan struct{})

	client, sink := streamingClient(t, func(
		ctx context.Context, _ json.RawMessage, _ func(capability.Chunk) error,
	) error {
		close(running)
		<-ctx.Done()

		return ctx.Err()
	}, nil)

	go client.handleStream(context.Background(), logRequest("req-1", "stream-1"))

	<-running

	if !client.streams.cancel("req-1", "stream-1") {
		t.Fatal("the cancel did not reach the stream")
	}

	waitForMessage(t, sink, protocol.TypeStreamEnd)

	if sink.find(protocol.TypeStreamEnd)["reason"] != protocol.StreamCancelled {
		t.Errorf("reason = %v, want cancelled", sink.find(protocol.TypeStreamEnd)["reason"])
	}
}

/*
A cancel that names the wrong stream is ignored.

Request identifiers are unique, but a cancel arriving for a stream that has
already ended and been replaced must not end the replacement.
*/
func TestCancelIsIgnoredWhenTheStreamIdentifierDoesNotMatch(t *testing.T) {
	running := make(chan struct{})

	client, _ := streamingClient(t, func(
		ctx context.Context, _ json.RawMessage, _ func(capability.Chunk) error,
	) error {
		close(running)
		<-ctx.Done()

		return ctx.Err()
	}, nil)

	go client.handleStream(context.Background(), logRequest("req-1", "stream-1"))

	<-running

	if client.streams.cancel("req-1", "stream-2") {
		t.Fatal("a cancel for another stream ended this one")
	}

	if client.streams.cancel("req-2", "stream-1") {
		t.Fatal("a cancel for another request ended this stream")
	}

	client.streams.cancelAll()
}

/*
Streams end with the connection that carried them.

A stream that outlived its connection would keep a Docker reader open for a
server that can no longer be reached, and its next chunk would be written to a
socket belonging to a different session.
*/
func TestAllStreamsEndWhenTheConnectionGoes(t *testing.T) {
	running := make(chan struct{}, 2)

	client, _ := streamingClient(t, func(
		ctx context.Context, _ json.RawMessage, _ func(capability.Chunk) error,
	) error {
		running <- struct{}{}
		<-ctx.Done()

		return ctx.Err()
	}, nil)

	go client.handleStream(context.Background(), logRequest("req-1", "stream-1"))
	go client.handleStream(context.Background(), logRequest("req-2", "stream-2"))

	<-running
	<-running

	client.streams.cancelAll()

	deadline := time.Now().Add(5 * time.Second)

	for client.streams.count() > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	if client.streams.count() != 0 {
		t.Fatalf("%d streams are still running after the connection ended", client.streams.count())
	}
}

/*
A write that fails ends the stream rather than being retried.

The server has gone. Continuing would hold a Docker reader open for a consumer
that is not there.
*/
func TestAStreamStopsWhenItCannotBeDelivered(t *testing.T) {
	emitted := 0

	client, sink := streamingClient(t, func(
		_ context.Context, _ json.RawMessage, emit func(capability.Chunk) error,
	) error {
		for index := 0; index < 100; index++ {
			if err := emit(capability.Chunk{Payload: map[string]any{"lines": []any{}}}); err != nil {
				return err
			}

			emitted++
		}

		return nil
	}, nil)

	sink.fail = true

	client.handleStream(context.Background(), logRequest("req-1", "stream-1"))

	if emitted != 0 {
		t.Fatalf("emitted %d chunks after the connection failed", emitted)
	}
}

/*
The agent's own log never carries log content.

A container's output may hold anything the application chose to print. It is
forwarded to whoever holds the permission to read it and written nowhere else.
*/
func TestStreamLoggingCarriesNoLogContent(t *testing.T) {
	const secret = "PASSWORD=THIS-MUST-NOT-BE-LOGGED"

	var written bytes.Buffer

	client, _ := streamingClient(t, func(
		_ context.Context, _ json.RawMessage, emit func(capability.Chunk) error,
	) error {
		return emit(capability.Chunk{
			Payload: map[string]any{"lines": []map[string]string{{"message": secret}}},
			Dropped: 3,
		})
	}, &written)

	client.handleStream(context.Background(), logRequest("req-1", "stream-1"))

	if strings.Contains(written.String(), secret) {
		t.Fatalf("the agent log carries log content:\n%s", written.String())
	}

	// The stream itself is still accounted for, so an operator can see that one
	// ran without seeing what it carried.
	if !strings.Contains(written.String(), "stream_opened") {
		t.Error("the agent log does not record that a stream ran")
	}
}

func waitForMessage(t *testing.T, sink *recorder, messageType string) {
	t.Helper()

	deadline := time.Now().Add(5 * time.Second)

	for time.Now().Before(deadline) {
		if sink.find(messageType) != nil {
			return
		}

		time.Sleep(10 * time.Millisecond)
	}

	t.Fatalf("no %s message arrived", messageType)
}
