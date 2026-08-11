package docker_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/docker/docker/api/types/container"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Container logs against the Engine API.

What matters here is which Docker call is made, that the multiplexed stream is
demultiplexed rather than shown raw, that one line cannot cost unbounded memory,
and that cancelling actually closes the reader the daemon is writing to.
*/

// multiplexed builds the frame format the daemon uses when there is no TTY:
// an 8-byte header per frame carrying the stream and the payload length.
func multiplexed(frames ...[2]string) io.ReadCloser {
	var buffer bytes.Buffer

	for _, frame := range frames {
		header := make([]byte, 8)

		if frame[0] == docker.StreamStderr {
			header[0] = 2
		} else {
			header[0] = 1
		}

		binary.BigEndian.PutUint32(header[4:], uint32(len(frame[1])))
		buffer.Write(header)
		buffer.WriteString(frame[1])
	}

	return io.NopCloser(bytes.NewReader(buffer.Bytes()))
}

// collect drains a log stream into one slice.
func collect(t *testing.T, batches <-chan docker.LogBatch) ([]docker.LogLine, int) {
	t.Helper()

	var (
		lines   []docker.LogLine
		dropped int
	)

	for batch := range batches {
		lines = append(lines, batch.Lines...)
		dropped += batch.Dropped
	}

	return lines, dropped
}

func logStream(t *testing.T, client *fakeClient, options docker.LogOptions) ([]docker.LogLine, int) {
	t.Helper()

	engine := docker.NewEngine(client)

	batches, failures, err := engine.Logs(context.Background(), "aaa111", options, 16)

	if err != nil {
		t.Fatalf("logs: %v", err)
	}

	lines, dropped := collect(t, batches)

	if err := <-failures; err != nil {
		t.Fatalf("stream: %v", err)
	}

	return lines, dropped
}

func TestLogsReadsThroughTheLogsApi(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed([2]string{docker.StreamStdout, "ready\n"})
	}}

	logStream(t, client, docker.LogOptions{Stdout: true, Stderr: true})

	// One call, and it is the logs endpoint. Nothing attaches, execs or starts.
	if len(client.calls) != 1 || client.calls[0] != "logs:aaa111" {
		t.Fatalf("calls = %v, want exactly one log read", client.calls)
	}
}

func TestLogsDemultiplexesStdoutAndStderr(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed(
			[2]string{docker.StreamStdout, "listening on 8080\n"},
			[2]string{docker.StreamStderr, "database unreachable\n"},
			[2]string{docker.StreamStdout, "retrying\n"},
		)
	}}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true, Stderr: true})

	if len(lines) != 3 {
		t.Fatalf("lines = %d, want 3: %+v", len(lines), lines)
	}

	byMessage := map[string]string{}

	for _, line := range lines {
		byMessage[line.Message] = line.Stream
	}

	if byMessage["listening on 8080"] != docker.StreamStdout {
		t.Errorf("stdout line reported as %q", byMessage["listening on 8080"])
	}

	if byMessage["database unreachable"] != docker.StreamStderr {
		t.Errorf("stderr line reported as %q", byMessage["database unreachable"])
	}
}

/*
The frame header is binary and must never be shown.

Docker's multiplexing puts eight bytes in front of every frame. Forwarding them
would put control characters into a viewer and make the first characters of
every line wrong.
*/
func TestLogsNeverForwardsTheFrameHeader(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed([2]string{docker.StreamStdout, "plain\n"})
	}}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true, Stderr: true})

	for _, line := range lines {
		if strings.ContainsRune(line.Message, 0) || line.Message != "plain" {
			t.Fatalf("message = %q, want the payload without its header", line.Message)
		}
	}
}

func TestLogsReadsASingleStreamFromATtyContainer(t *testing.T) {
	client := &fakeClient{
		inspect: container.InspectResponse{
			ContainerJSONBase: &container.ContainerJSONBase{ID: "aaa111"},
			Config:            &container.Config{Tty: true},
		},
		logs: func() io.ReadCloser {
			// A TTY container is not multiplexed: the bytes are the output.
			return io.NopCloser(strings.NewReader("first\nsecond\n"))
		},
	}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true, Stderr: true})

	if len(lines) != 2 || lines[0].Message != "first" || lines[1].Message != "second" {
		t.Fatalf("lines = %+v, want the two lines as written", lines)
	}
}

func TestLogsPassesTheRequestedOptionsToDocker(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser { return multiplexed() }}

	since := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)

	logStream(t, client, docker.LogOptions{
		Stdout:     true,
		Stderr:     false,
		Timestamps: true,
		Follow:     true,
		Tail:       250,
		Since:      since,
	})

	options := client.logsOptions

	if !options.ShowStdout || options.ShowStderr {
		t.Errorf("streams = stdout %v stderr %v, want stdout only", options.ShowStdout, options.ShowStderr)
	}

	if !options.Timestamps || !options.Follow {
		t.Errorf("timestamps = %v, follow = %v, want both", options.Timestamps, options.Follow)
	}

	if options.Tail != "250" {
		t.Errorf("tail = %q, want 250", options.Tail)
	}

	if !strings.HasPrefix(options.Since, "2026-08-10T12:00:00") {
		t.Errorf("since = %q, want the requested time", options.Since)
	}

	// Details are the container's logging-driver labels, which are configuration
	// rather than output and are never asked for.
	if options.Details {
		t.Error("details were requested")
	}
}

func TestLogsSeparatesTheDockerTimestamp(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed([2]string{docker.StreamStdout, "2026-08-10T12:00:00.123456789Z started\n"})
	}}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true, Timestamps: true})

	if len(lines) != 1 {
		t.Fatalf("lines = %+v", lines)
	}

	if lines[0].Timestamp != "2026-08-10T12:00:00.123456789Z" {
		t.Errorf("timestamp = %q", lines[0].Timestamp)
	}

	if lines[0].Message != "started" {
		t.Errorf("message = %q, want the line without its timestamp", lines[0].Message)
	}
}

/*
A line that only looks like a timestamp keeps its text.

Inventing a time for a line that carries none would misrepresent when something
happened, which is the one thing a log viewer must not do.
*/
func TestLogsInventsNoTimestamp(t *testing.T) {
	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed([2]string{docker.StreamStdout, "12:00:00 not a timestamp\n"})
	}}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true, Timestamps: true})

	if lines[0].Timestamp != "" {
		t.Errorf("timestamp = %q, want none", lines[0].Timestamp)
	}

	if lines[0].Message != "12:00:00 not a timestamp" {
		t.Errorf("message = %q, want the line unchanged", lines[0].Message)
	}
}

/*
One line cannot cost unbounded memory.

A container that never emits a newline would otherwise be able to grow the
agent until it is killed. The line is cut and every piece says so.
*/
func TestLogsBoundsASingleLine(t *testing.T) {
	huge := strings.Repeat("x", docker.MaxLineBytes*3)

	client := &fakeClient{logs: func() io.ReadCloser {
		return multiplexed([2]string{docker.StreamStdout, huge + "\n"})
	}}

	lines, _ := logStream(t, client, docker.LogOptions{Stdout: true})

	if len(lines) < 3 {
		t.Fatalf("lines = %d, want the line split into pieces", len(lines))
	}

	for _, line := range lines {
		if len(line.Message) > docker.MaxLineBytes {
			t.Fatalf("a piece is %d bytes, over the limit", len(line.Message))
		}

		if !line.Truncated {
			t.Error("a piece of an oversized line is not marked as truncated")
		}
	}
}

/*
A consumer that cannot keep up loses lines, and is told.

Blocking here would stop reading from Docker, which moves the backlog into the
daemon rather than solving it. Dropping silently would hand an operator an
incomplete log that looks complete.
*/
func TestLogsDropsAndCountsWhenTheConsumerIsBehind(t *testing.T) {
	var frames [][2]string

	for index := 0; index < docker.MaxBatchLines*20; index++ {
		frames = append(frames, [2]string{docker.StreamStdout, "line\n"})
	}

	client := &fakeClient{logs: func() io.ReadCloser { return multiplexed(frames...) }}
	engine := docker.NewEngine(client)

	// A queue of one, drained slowly, is a consumer that cannot keep up.
	batches, failures, err := engine.Logs(context.Background(), "aaa111", docker.LogOptions{Stdout: true}, 1)

	if err != nil {
		t.Fatalf("logs: %v", err)
	}

	var (
		received int
		dropped  int
	)

	for batch := range batches {
		received += len(batch.Lines)
		dropped += batch.Dropped
		time.Sleep(2 * time.Millisecond)
	}

	<-failures

	if dropped == 0 {
		t.Fatal("nothing was reported as dropped, so the loss would be invisible")
	}

	if received+dropped > len(frames) {
		t.Errorf("received %d + dropped %d exceeds the %d written", received, dropped, len(frames))
	}
}

/*
Cancelling stops the reader Docker is writing to.

A stream nobody is watching must not keep a Docker log reader open on the host.
*/
func TestLogsClosesTheReaderWhenCancelled(t *testing.T) {
	reader := &blockingReader{closed: make(chan struct{})}

	client := &fakeClient{logs: func() io.ReadCloser { return reader }}
	engine := docker.NewEngine(client)

	ctx, cancel := context.WithCancel(context.Background())

	batches, _, err := engine.Logs(ctx, "aaa111", docker.LogOptions{Stdout: true, Follow: true}, 4)

	if err != nil {
		t.Fatalf("logs: %v", err)
	}

	cancel()

	select {
	case <-reader.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the Docker reader was not closed after cancellation")
	}

	for range batches {
		// Drained so the goroutine can finish.
	}
}

func TestLogsRefusesAStreamThatAsksForNeitherOutput(t *testing.T) {
	engine := docker.NewEngine(&fakeClient{})

	if _, _, err := engine.Logs(context.Background(), "aaa111", docker.LogOptions{}, 4); err == nil {
		t.Fatal("expected a stream with no output to be refused")
	}
}

func TestLogsReportsAMissingContainer(t *testing.T) {
	client := &fakeClient{logsErr: errors.New("Error: No such container: aaa111")}
	engine := docker.NewEngine(client)

	if _, _, err := engine.Logs(context.Background(), "aaa111", docker.LogOptions{Stdout: true}, 4); err == nil {
		t.Fatal("expected a missing container to be reported")
	}
}

// blockingReader never returns data until it is closed, which is how a follow
// stream behaves while a container is quiet.
type blockingReader struct {
	closed chan struct{}
	once   bool
}

func (r *blockingReader) Read(p []byte) (int, error) {
	<-r.closed
	return 0, io.EOF
}

func (r *blockingReader) Close() error {
	if !r.once {
		r.once = true
		close(r.closed)
	}

	return nil
}
