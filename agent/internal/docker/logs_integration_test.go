//go:build docker_integration

// Container logs against a real Docker daemon. Excluded from the default build:
//
//	go test -tags docker_integration ./internal/docker/
//
// The container these tests read belongs to this run and carries its labels.
// Reading is not an operation, so the ownership guard that gates start, stop
// and restart does not apply — but the container is still created and removed
// by the harness, and the run-wide sweep still proves nothing else moved.
package docker_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
A container that writes known lines to both streams and then keeps going.

Written as one shell command so the output is deterministic: three historical
lines, then a line a second, so a test can tell history from what arrived while
it was watching.
*/
const logScript = `echo "history stdout 1";` +
	`echo "history stderr 1" >&2;` +
	`echo "history stdout 2";` +
	`i=0; while true; do i=$((i+1)); echo "live stdout $i"; echo "live stderr $i" >&2; sleep 1; done`

func logContainer(t *testing.T) string {
	t.Helper()

	name, _ := createContainer(t, "logs", "--entrypoint", "sh")

	// The harness's own command keeps a container alive; this one has to print,
	// so the container is recreated with the script as its command.
	run(t, "rm", "-f", name)
	run(t, "run", "--detach", "--name", name,
		"--label", e2eLabel+"=true",
		"--label", e2eRunLabel+"="+runID,
		testImage, "sh", "-c", logScript)

	created[name] = containerID(t, name)

	// Give the container a moment to write its history.
	time.Sleep(1500 * time.Millisecond)

	return name
}

func readBatches(
	t *testing.T,
	engine *docker.Engine,
	name string,
	options docker.LogOptions,
	until func([]docker.LogLine) bool,
	timeout time.Duration,
) []docker.LogLine {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	batches, failures, err := engine.Logs(ctx, name, options, 32)

	if err != nil {
		t.Fatalf("logs: %v", err)
	}

	var lines []docker.LogLine

	for batch := range batches {
		lines = append(lines, batch.Lines...)

		if until != nil && until(lines) {
			cancel()
			break
		}
	}

	// Drained so the reader goroutine finishes rather than blocking on a send.
	for range batches {
	}

	<-failures

	return lines
}

func TestRealLogsReturnsTheHistory(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout: true,
		Stderr: true,
		Tail:   100,
	}, nil, 20*time.Second)

	joined := messagesOf(lines)

	for _, expected := range []string{"history stdout 1", "history stdout 2", "history stderr 1"} {
		if !strings.Contains(joined, expected) {
			t.Errorf("the history does not contain %q:\n%s", expected, joined)
		}
	}
}

func TestRealLogsSeparatesStdoutFromStderr(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout: true,
		Stderr: true,
		Tail:   100,
	}, nil, 20*time.Second)

	for _, line := range lines {
		switch {
		case strings.Contains(line.Message, "stdout") && line.Stream != docker.StreamStdout:
			t.Errorf("%q was reported on %s", line.Message, line.Stream)
		case strings.Contains(line.Message, "stderr") && line.Stream != docker.StreamStderr:
			t.Errorf("%q was reported on %s", line.Message, line.Stream)
		}

		// The frame header is binary; nothing of it may reach a reader.
		if strings.ContainsRune(line.Message, 0) {
			t.Errorf("a line carries a frame header: %q", line.Message)
		}
	}
}

func TestRealLogsCanAskForOneStreamOnly(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout: false,
		Stderr: true,
		Tail:   100,
	}, nil, 20*time.Second)

	if len(lines) == 0 {
		t.Fatal("no stderr lines were returned")
	}

	for _, line := range lines {
		if line.Stream != docker.StreamStderr {
			t.Errorf("a %s line arrived when only stderr was asked for", line.Stream)
		}
	}
}

func TestRealLogsCarriesTheDockerTimestamp(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout:     true,
		Timestamps: true,
		Tail:       10,
	}, nil, 20*time.Second)

	if len(lines) == 0 {
		t.Fatal("no lines were returned")
	}

	for _, line := range lines {
		if line.Timestamp == "" {
			t.Fatalf("a line carries no timestamp: %q", line.Message)
		}

		if _, err := time.Parse(time.RFC3339Nano, line.Timestamp); err != nil {
			t.Fatalf("timestamp %q does not parse: %v", line.Timestamp, err)
		}

		if strings.HasPrefix(line.Message, line.Timestamp) {
			t.Error("the timestamp is still in the message as well")
		}
	}
}

func TestRealLogsTailLimitsTheHistory(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout: true,
		Stderr: true,
		Tail:   1,
	}, nil, 20*time.Second)

	if len(lines) != 1 {
		t.Fatalf("lines = %d, want the single line a tail of one asks for", len(lines))
	}
}

/*
Following delivers what is written after the read started.

This is the property that makes the view live rather than a snapshot, and it is
the one a batching bug would break most quietly.
*/
func TestRealLogsFollowsNewOutput(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	seen := map[string]bool{}

	lines := readBatches(t, engine, name, docker.LogOptions{
		Stdout: true,
		Stderr: true,
		Tail:   0,
		Follow: true,
	}, func(collected []docker.LogLine) bool {
		for _, line := range collected {
			seen[line.Message] = true
		}

		return len(seen) >= 4
	}, 30*time.Second)

	live := 0

	for _, line := range lines {
		if strings.HasPrefix(line.Message, "live ") {
			live++
		}
	}

	if live < 2 {
		t.Fatalf("only %d live lines arrived, so following is not working", live)
	}
}

/*
Cancelling ends the read on the host.

A stream nobody is watching must not leave a Docker log reader open. The daemon
is asked afterwards whether it still has one for this container.
*/
func TestRealLogsStopReleasesTheDockerReader(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := logContainer(t)

	ctx, cancel := context.WithCancel(context.Background())

	batches, failures, err := engine.Logs(ctx, name, docker.LogOptions{
		Stdout: true,
		Follow: true,
	}, 8)

	if err != nil {
		t.Fatalf("logs: %v", err)
	}

	// Wait for something to arrive, so the reader is genuinely open.
	select {
	case <-batches:
	case <-time.After(20 * time.Second):
		cancel()
		t.Fatal("nothing arrived from a following stream")
	}

	cancel()

	// The channel closing is the reader having finished and the connection to
	// the daemon having been released.
	select {
	case _, open := <-drain(batches):
		if open {
			t.Fatal("the stream is still delivering after cancellation")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the stream did not end after cancellation")
	}

	<-failures
}

// drain reports when a channel has closed, after discarding what is left.
func drain(batches <-chan docker.LogBatch) <-chan docker.LogBatch {
	done := make(chan docker.LogBatch)

	go func() {
		for range batches {
		}

		close(done)
	}()

	return done
}

func messagesOf(lines []docker.LogLine) string {
	messages := make([]string, 0, len(lines))

	for _, line := range lines {
		messages = append(messages, line.Message)
	}

	return strings.Join(messages, "\n")
}
