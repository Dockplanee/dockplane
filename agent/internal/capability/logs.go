package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
The log capability.

It reads a container's output and hands it on. Everything about its shape is
chosen so that it cannot become anything else: the payload is a container
identifier plus a fixed set of log options, there is no field carrying a
command, an argument list or input of any kind, and the only Docker call it can
reach is the Logs API. Docker's attach endpoint — the one that carries stdin —
is absent from the agent's client interface entirely.
*/

// How long the agent will keep a log stream open on its own account.
//
// The control server decides how long a stream should live and cancels it. This
// is the backstop for a stream the server forgot: an agent should not read a
// container's logs for the life of the process because a message went missing.
const MaxLogStreamDuration = 60 * time.Minute

// Bounds the caller may not exceed. The server validates these too; the agent
// checks again because it does not treat an authenticated peer as correct.
const (
	// MaxLogTail is the most historical lines a request may ask for.
	MaxLogTail = 5000
	// logQueueDepth is how many batches may wait for the connection.
	logQueueDepth = 32
)

/*
logsRequest is the entire vocabulary of a log request.

Written out field by field rather than passed through. A request cannot name a
Docker option this list does not have, so the set of things a caller can ask the
daemon for is fixed in this file rather than by whatever Docker happens to
support.
*/
type logsRequest struct {
	ContainerID string `json:"containerId"`
	Tail        int    `json:"tail"`
	Since       string `json:"since"`
	Timestamps  bool   `json:"timestamps"`
	Stdout      bool   `json:"stdout"`
	Stderr      bool   `json:"stderr"`
	Follow      bool   `json:"follow"`
}

// logsChunk is what one delivery carries.
type logsChunk struct {
	Lines []docker.LogLine `json:"lines"`
}

// registerLogs wires the only capability that answers over time.
func registerLogs(registry *Registry, sources Sources) {
	registry.RegisterStream(StreamDefinition{
		Name:        ContainerLogs,
		MaxDuration: MaxLogStreamDuration,
		Handler: func(ctx context.Context, payload json.RawMessage, emit func(Chunk) error) error {
			request, err := parseLogsRequest(payload)

			if err != nil {
				return err
			}

			return streamLogs(ctx, sources.Docker, request, emit)
		},
	})
}

/*
parseLogsRequest validates a request before any of it reaches Docker.

Decoding is strict: a payload carrying a field this struct does not define is
refused rather than ignored. A request that tried to smuggle a command, an
argument list or anything resembling input therefore fails here, instead of
being silently dropped and leaving the caller to believe it was accepted.
*/
func parseLogsRequest(payload json.RawMessage) (logsRequest, error) {
	var request logsRequest

	if err := decode(payload, &request); err != nil {
		return request, err
	}

	if !identifierPattern.MatchString(request.ContainerID) {
		return request, fmt.Errorf("%w: containerId", ErrInvalidPayload)
	}

	if request.Tail < 0 || request.Tail > MaxLogTail {
		return request, fmt.Errorf("%w: tail", ErrInvalidPayload)
	}

	if !request.Stdout && !request.Stderr {
		return request, fmt.Errorf("%w: neither stdout nor stderr", ErrInvalidPayload)
	}

	if request.Since != "" {
		if _, err := time.Parse(time.RFC3339, request.Since); err != nil {
			return request, fmt.Errorf("%w: since", ErrInvalidPayload)
		}
	}

	return request, nil
}

// streamLogs opens the Docker reader and forwards what comes out of it.
func streamLogs(
	ctx context.Context,
	engine *docker.Engine,
	request logsRequest,
	emit func(Chunk) error,
) error {
	options := docker.LogOptions{
		Stdout:     request.Stdout,
		Stderr:     request.Stderr,
		Timestamps: request.Timestamps,
		Follow:     request.Follow,
		Tail:       request.Tail,
	}

	if request.Since != "" {
		// Already validated; a parse failure here is impossible by construction.
		options.Since, _ = time.Parse(time.RFC3339, request.Since)
	}

	/*
	 * The reader is tied to a context of its own so that returning from this
	 * function — because the consumer has gone, or the stream was cancelled —
	 * closes the Docker reader rather than leaving it open on the host.
	 */
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	batches, failures, err := engine.Logs(streamCtx, request.ContainerID, options, logQueueDepth)

	if err != nil {
		return wrapDocker(err)
	}

	for batch := range batches {
		if len(batch.Lines) == 0 && batch.Dropped == 0 {
			continue
		}

		if err := emit(Chunk{
			Payload: logsChunk{Lines: batch.Lines},
			Dropped: batch.Dropped,
		}); err != nil {
			// The consumer has gone. Cancelling here is what stops Docker.
			cancel()

			// Drained so the reader goroutine can finish rather than block.
			for range batches {
			}

			return err
		}
	}

	if err := <-failures; err != nil && !errors.Is(err, context.Canceled) {
		return wrapDocker(err)
	}

	return nil
}
