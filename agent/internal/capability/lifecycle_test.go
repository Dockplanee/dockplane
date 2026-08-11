package capability_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
The lifecycle capabilities as the gateway reaches them.

These go through the registry rather than calling the engine directly, because
what is under test is the shape of the request an agent will accept: an
identifier and nothing else, validated before Docker is touched.
*/
func lifecycleRegistry(engine *docker.Engine) *capability.Registry {
	registry := capability.New()
	capability.Register(registry, capability.Sources{Docker: engine})

	return registry
}

func payload(id string) json.RawMessage {
	return json.RawMessage(`{"containerId":"` + id + `"}`)
}

func TestLifecycleCapabilitiesAreRegistered(t *testing.T) {
	registry := lifecycleRegistry(nil)
	names := registry.Names()

	found := map[string]bool{}

	for _, name := range names {
		found[name] = true
	}

	for _, expected := range []string{
		capability.ContainerStart,
		capability.ContainerStop,
		capability.ContainerRestart,
	} {
		if !found[expected] {
			t.Errorf("%s is not registered", expected)
		}
	}
}

/*
A capability takes an identifier, never an operation.

There is no field in which a caller could name a command, and an identifier that
does not look like one is refused before the Engine API sees it.
*/
func TestLifecycleRefusesAnIdentifierItDoesNotRecognise(t *testing.T) {
	registry := lifecycleRegistry(nil)

	for _, bad := range []string{
		`{"containerId":"; rm -rf /"}`,
		`{"containerId":"$(whoami)"}`,
		`{"containerId":""}`,
		`{"containerId":"../../etc/passwd"}`,
		`{}`,
	} {
		_, err := registry.Invoke(context.Background(), capability.ContainerStart, json.RawMessage(bad))

		if !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", bad, err)
		}
	}
}

func TestUnknownCapabilityIsRefusedBeforeAnythingRuns(t *testing.T) {
	registry := lifecycleRegistry(nil)

	for _, name := range []string{"container.remove", "container.exec", "docker.command", "shell"} {
		_, err := registry.Invoke(context.Background(), name, payload("aaa111"))

		if !errors.Is(err, capability.ErrUnsupported) {
			t.Errorf("%s: error = %v, want ErrUnsupported", name, err)
		}
	}
}
