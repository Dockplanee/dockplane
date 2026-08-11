package capability_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/capability"
)

/*
The log capability as the gateway reaches it.

The subject is the shape of the request an agent will accept. A log request
names a container and a fixed set of log options; there is no field for a
command, an argument list or input, and a payload that carries one is refused
rather than quietly stripped.
*/

func logsRegistry() *capability.Registry {
	registry := capability.New()
	capability.Register(registry, capability.Sources{})

	return registry
}

func invokeLogs(t *testing.T, payload string) error {
	t.Helper()

	return logsRegistry().InvokeStream(
		context.Background(),
		capability.ContainerLogs,
		json.RawMessage(payload),
		func(capability.Chunk) error { return nil },
	)
}

func TestLogsIsRegisteredAsAStream(t *testing.T) {
	registry := logsRegistry()

	if !registry.IsStream(capability.ContainerLogs) {
		t.Fatal("container.logs is not registered as a stream")
	}

	// It answers over time, so it must not also be reachable as a single call.
	_, err := registry.Invoke(context.Background(), capability.ContainerLogs, json.RawMessage(`{}`))

	if !errors.Is(err, capability.ErrUnsupported) {
		t.Errorf("error = %v, want the single-call path to refuse it", err)
	}
}

/*
Nothing that could carry input is accepted.

This is the property that keeps a log stream from becoming a console. Each of
these payloads is refused because the request type has no such field, so an
agent cannot be talked into reading one by a server that sends it.
*/
func TestLogsRefusesAnyInputOrCommandPayload(t *testing.T) {
	forbidden := []string{
		`{"containerId":"web","stdout":true,"command":"sh"}`,
		`{"containerId":"web","stdout":true,"cmd":["sh","-c","id"]}`,
		`{"containerId":"web","stdout":true,"stdin":"whoami\n"}`,
		`{"containerId":"web","stdout":true,"input":"data"}`,
		`{"containerId":"web","stdout":true,"attach":true}`,
		`{"containerId":"web","stdout":true,"attachStdin":true}`,
		`{"containerId":"web","stdout":true,"exec":{"cmd":["sh"]}}`,
		`{"containerId":"web","stdout":true,"tty":true}`,
		`{"containerId":"web","stdout":true,"detachKeys":"ctrl-c"}`,
		`{"containerId":"web","stdout":true,"env":["A=b"]}`,
		`{"containerId":"web","stdout":true,"privileged":true}`,
		`{"containerId":"web","stdout":true,"user":"root"}`,
	}

	for _, payload := range forbidden {
		err := invokeLogs(t, payload)

		if !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", payload, err)
		}
	}
}

func TestLogsRefusesAnIdentifierItDoesNotRecognise(t *testing.T) {
	for _, payload := range []string{
		`{"containerId":"; rm -rf /","stdout":true}`,
		`{"containerId":"$(whoami)","stdout":true}`,
		`{"containerId":"","stdout":true}`,
		`{"containerId":"../../etc/passwd","stdout":true}`,
		`{"stdout":true}`,
	} {
		if err := invokeLogs(t, payload); !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", payload, err)
		}
	}
}

func TestLogsRefusesAnUnreasonableTail(t *testing.T) {
	for _, payload := range []string{
		`{"containerId":"web","stdout":true,"tail":-1}`,
		`{"containerId":"web","stdout":true,"tail":5001}`,
		`{"containerId":"web","stdout":true,"tail":1000000}`,
	} {
		if err := invokeLogs(t, payload); !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", payload, err)
		}
	}
}

func TestLogsRefusesARequestForNeitherOutput(t *testing.T) {
	err := invokeLogs(t, `{"containerId":"web","stdout":false,"stderr":false}`)

	if !errors.Is(err, capability.ErrInvalidPayload) {
		t.Errorf("error = %v, want ErrInvalidPayload", err)
	}
}

func TestLogsRefusesASinceItCannotParse(t *testing.T) {
	err := invokeLogs(t, `{"containerId":"web","stdout":true,"since":"yesterday"}`)

	if !errors.Is(err, capability.ErrInvalidPayload) {
		t.Errorf("error = %v, want ErrInvalidPayload", err)
	}
}

/*
The agent has a ceiling of its own.

The control server decides how long a stream should live. This exists for the
stream it forgets: an agent must not read a container's logs for the life of the
process because a cancel went missing.
*/
func TestLogsCarriesAnAgentSideCeiling(t *testing.T) {
	if capability.MaxLogStreamDuration <= 0 {
		t.Fatal("a log stream has no agent-side ceiling")
	}
}

/*
No capability that carries input exists at all.

The registry is the only way to reach an operation, so a name that is not in it
cannot be invoked however the request is shaped.
*/
func TestNoInputCapabilityIsReachable(t *testing.T) {
	registry := logsRegistry()

	for _, name := range []string{
		"container.attach", "container.exec", "container.stdin",
		"container.console", "container.terminal", "shell", "exec",
	} {
		if registry.IsStream(name) {
			t.Errorf("%s is registered as a stream", name)
		}

		err := registry.InvokeStream(
			context.Background(), name, json.RawMessage(`{}`),
			func(capability.Chunk) error { return nil },
		)

		if !errors.Is(err, capability.ErrUnsupported) {
			t.Errorf("%s: error = %v, want ErrUnsupported", name, err)
		}
	}
}

/*
The request vocabulary is fixed in the agent, not by Docker.

Whatever options the Engine API grows, only the ones written into the request
type can be asked for. This reads the source rather than the behaviour, because
what matters is that the list stays short and deliberate.
*/
func TestLogRequestNamesOnlyTheOptionsTheProductDefines(t *testing.T) {
	source := readSource(t, "logs.go")

	for _, allowed := range []string{
		`json:"containerId"`, `json:"tail"`, `json:"since"`,
		`json:"timestamps"`, `json:"stdout"`, `json:"stderr"`, `json:"follow"`,
	} {
		if !strings.Contains(source, allowed) {
			t.Errorf("the request no longer defines %s", allowed)
		}
	}

	for _, forbidden := range []string{
		`json:"cmd"`, `json:"command"`, `json:"stdin"`, `json:"attach"`,
		`json:"exec"`, `json:"until"`, `json:"details"`,
	} {
		if strings.Contains(source, forbidden) {
			t.Errorf("the request defines %s, which a caller must not control", forbidden)
		}
	}
}

// readSource returns a file of this package, so a test can assert what the
// code declares rather than only what it happens to do at runtime.
func readSource(t *testing.T, name string) string {
	t.Helper()

	content, err := os.ReadFile(name)

	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}

	return string(content)
}
