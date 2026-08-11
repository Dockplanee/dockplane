package docker

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
)

/*
Container logs.

Read through the Engine Logs API and nothing else. Docker also offers attach,
which carries stdin and would make this a way to write into a container; that
API is deliberately absent from the client interface, so no code path here can
reach it however the request is shaped.

The stream is one-directional by construction: the agent opens a reader, copies
what comes out of it, and closes it. There is no handle a caller could write to.
*/

// Bounds on what one line and one batch may cost. A container that logs a
// gigabyte on one line, or faster than the network drains, must not be able to
// grow the agent's memory.
const (
	// MaxLineBytes is the longest single log line forwarded intact.
	MaxLineBytes = 8 * 1024
	// MaxBatchLines is the most lines gathered before a batch is handed on.
	MaxBatchLines = 200
	// MaxBatchBytes is the most bytes gathered before a batch is handed on.
	MaxBatchBytes = 64 * 1024
	// BatchInterval is how long a partial batch waits for company.
	BatchInterval = 100 * time.Millisecond
	// readBufferBytes sizes the scanner, which must hold one whole line.
	readBufferBytes = MaxLineBytes + 1024
)

// Stream names as they are reported. Docker multiplexes both onto one
// connection; they are separated here so an operator can tell them apart.
const (
	StreamStdout = "stdout"
	StreamStderr = "stderr"
)

// LogLine is one line as it left the container.
type LogLine struct {
	Stream string `json:"stream"`
	// Timestamp is what Docker recorded, present only when timestamps were
	// asked for. Nothing is invented for a line that carries none.
	Timestamp string `json:"timestamp,omitempty"`
	Message   string `json:"message"`
	// Truncated marks a line that was longer than the agent forwards.
	Truncated bool `json:"truncated,omitempty"`
}

// LogOptions is the complete set of choices a caller has. It mirrors the
// options the control server accepts, and nothing beyond them reaches Docker.
type LogOptions struct {
	Stdout     bool
	Stderr     bool
	Timestamps bool
	Follow     bool
	// Tail is the number of historical lines, 0 for none.
	Tail int
	// Since is an absolute time. A zero value asks for everything Docker kept.
	Since time.Time
}

// LogBatch is a group of lines delivered together, with what was lost before it.
type LogBatch struct {
	Lines []LogLine
	// Dropped counts lines discarded since the previous batch because the
	// consumer could not keep up. It is reported rather than hidden.
	Dropped int
}

/*
Logs streams a container's output until the context ends.

Batches are delivered on the returned channel, which is closed when the stream
finishes. The error channel carries at most one value: why it finished, or nil
when Docker closed the stream by itself. Cancelling the context closes the
Docker reader, which is what stops the daemon sending more.

The channel is bounded. When the consumer falls behind, lines are dropped and
counted rather than queued without limit, and the count travels with the next
batch so the operator is told rather than quietly served an incomplete log.
*/
func (e *Engine) Logs(
	ctx context.Context,
	id string,
	options LogOptions,
	queueDepth int,
) (<-chan LogBatch, <-chan error, error) {
	if !options.Stdout && !options.Stderr {
		return nil, nil, errors.New("neither stdout nor stderr was requested")
	}

	reader, err := e.client.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: options.Stdout,
		ShowStderr: options.Stderr,
		Timestamps: options.Timestamps,
		Follow:     options.Follow,
		Tail:       tailArgument(options.Tail),
		Since:      sinceArgument(options.Since),
		// Details would add the container's own logging-driver labels to every
		// line. They are configuration, not output, and are not forwarded.
		Details: false,
	})

	if err != nil {
		return nil, nil, lifecycleError(err)
	}

	batches := make(chan LogBatch, queueDepth)
	failures := make(chan error, 1)

	inspected, inspectErr := e.client.ContainerInspect(ctx, id)
	tty := inspectErr == nil && inspected.Config != nil && inspected.Config.Tty

	/*
	 * Cancellation closes the reader rather than waiting for it.
	 *
	 * A follow stream blocks in Read until the container writes something, so
	 * returning from the copy loop is not something cancellation can cause on
	 * its own. Closing the reader is what ends the request to the daemon, and
	 * therefore what stops it producing.
	 */
	stopReader := sync.OnceFunc(func() { _ = reader.Close() })
	finished := make(chan struct{})

	go func() {
		select {
		case <-ctx.Done():
			stopReader()
		case <-finished:
		}
	}()

	go func() {
		defer close(batches)
		defer close(finished)
		defer stopReader()

		failures <- readLogs(ctx, reader, tty, options.Timestamps, batches)
	}()

	return batches, failures, nil
}

/*
readLogs demultiplexes the Docker stream and groups lines into batches.

Without a TTY the daemon multiplexes stdout and stderr onto one connection with
an 8-byte frame header. Those headers are binary and must never reach a viewer
as text, so the stream is split with the SDK's own demultiplexer and each side
is read as lines.
*/
func readLogs(
	ctx context.Context,
	reader io.Reader,
	tty bool,
	timestamps bool,
	batches chan<- LogBatch,
) error {
	lines := make(chan LogLine, MaxBatchLines)
	done := make(chan error, 1)

	if tty {
		// A TTY container has one stream and no frame headers. Docker reports
		// everything as stdout, and so does this.
		go func() {
			done <- scanInto(ctx, reader, StreamStdout, lines)
			close(lines)
		}()
	} else {
		go splitStreams(ctx, reader, lines, done)
	}

	collector := &batcher{out: batches, timestamps: timestamps}

	/*
	 * A partial batch is handed on after a short wait.
	 *
	 * Without it, a container that logs one line a minute would have that line
	 * sit in the agent until enough others arrived to fill a batch — a live
	 * view that is minutes behind is not a live view.
	 */
	ticker := time.NewTicker(BatchInterval)
	defer ticker.Stop()

	for {
		select {
		case line, open := <-lines:
			if !open {
				collector.flush()

				if err := <-done; err != nil && !errors.Is(err, io.EOF) {
					return err
				}

				return nil
			}

			collector.add(line)

		case <-ticker.C:
			collector.flush()

		case <-ctx.Done():
			collector.flush()
			return nil
		}
	}
}

// splitStreams demultiplexes the framed Docker stream into one line channel.
func splitStreams(ctx context.Context, reader io.Reader, lines chan<- LogLine, done chan<- error) {
	stdout, stdoutWriter := io.Pipe()
	stderr, stderrWriter := io.Pipe()

	copied := make(chan error, 1)

	go func() {
		_, err := stdcopy.StdCopy(stdoutWriter, stderrWriter, reader)
		stdoutWriter.CloseWithError(err)
		stderrWriter.CloseWithError(err)
		copied <- err
	}()

	readers := make(chan error, 2)

	go func() { readers <- scanInto(ctx, stdout, StreamStdout, lines) }()
	go func() { readers <- scanInto(ctx, stderr, StreamStderr, lines) }()

	<-readers
	<-readers

	done <- <-copied
	close(lines)
}

// scanInto reads one stream into the shared line channel.
func scanInto(ctx context.Context, reader io.Reader, stream string, lines chan<- LogLine) error {
	return scanLines(ctx, reader, stream, lineSink(func(line LogLine) {
		select {
		case lines <- line:
		case <-ctx.Done():
		}
	}))
}

type lineSink func(LogLine)

func (s lineSink) add(line LogLine) { s(line) }

type collector interface {
	add(LogLine)
}

/*
scanLines splits a stream into lines, bounding what one line may cost.

A line longer than the limit is cut and marked rather than buffered whole: a
container that never emits a newline would otherwise hold the agent's memory
hostage, and silently discarding the remainder would misrepresent the output.
*/
func scanLines(ctx context.Context, reader io.Reader, stream string, out collector) error {
	buffered := bufio.NewReaderSize(reader, readBufferBytes)

	for {
		if ctx.Err() != nil {
			return nil
		}

		chunk, err := buffered.ReadString('\n')

		if len(chunk) > 0 {
			for _, line := range splitOversized(strings.TrimRight(chunk, "\r\n"), stream) {
				out.add(line)
			}
		}

		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrClosedPipe) {
				return nil
			}

			return err
		}
	}
}

// splitOversized cuts a line that exceeds the limit, marking every piece.
func splitOversized(text, stream string) []LogLine {
	if len(text) <= MaxLineBytes {
		return []LogLine{{Stream: stream, Message: text}}
	}

	var lines []LogLine

	for len(text) > 0 {
		size := min(len(text), MaxLineBytes)

		lines = append(lines, LogLine{
			Stream:    stream,
			Message:   text[:size],
			Truncated: true,
		})

		text = text[size:]
	}

	return lines
}

/*
batcher groups lines and hands them on without blocking the reader.

A full channel means the consumer is behind. The batch is dropped and counted
instead of waiting, because waiting here would stop reading from Docker, and a
daemon whose log reader stalls holds the output in its own buffers instead.
*/
type batcher struct {
	out        chan<- LogBatch
	timestamps bool
	lines      []LogLine
	bytes      int
	dropped    int
}

func (b *batcher) add(line LogLine) {
	if b.timestamps {
		line.Timestamp, line.Message = splitTimestamp(line.Message)
	}

	b.lines = append(b.lines, line)
	b.bytes += len(line.Message)

	if len(b.lines) >= MaxBatchLines || b.bytes >= MaxBatchBytes {
		b.flush()
	}
}

func (b *batcher) flush() {
	if len(b.lines) == 0 && b.dropped == 0 {
		return
	}

	batch := LogBatch{Lines: b.lines, Dropped: b.dropped}

	select {
	case b.out <- batch:
		b.dropped = 0
	default:
		// The consumer is behind. What could not be delivered is counted so the
		// next batch that does get through reports the gap.
		b.dropped += len(b.lines)
	}

	b.lines = nil
	b.bytes = 0
}

/*
splitTimestamp separates the RFC 3339 prefix Docker writes.

Only a prefix that actually parses is treated as one. A line that happens to
begin with something timestamp-shaped keeps it as content rather than having a
time invented for it.
*/
func splitTimestamp(message string) (string, string) {
	space := strings.IndexByte(message, ' ')

	if space <= 0 {
		return "", message
	}

	prefix := message[:space]

	if _, err := time.Parse(time.RFC3339Nano, prefix); err != nil {
		return "", message
	}

	return prefix, message[space+1:]
}

// tailArgument converts the line count into what the Engine API expects.
func tailArgument(tail int) string {
	if tail <= 0 {
		return "0"
	}

	return itoa(tail)
}

// sinceArgument formats an absolute lower bound, or nothing for no bound.
func sinceArgument(since time.Time) string {
	if since.IsZero() {
		return ""
	}

	return since.UTC().Format(time.RFC3339Nano)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}

	var digits [20]byte

	index := len(digits)

	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}

	return string(digits[index:])
}
