package capability_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
)

func TestInvokeRefusesAnUnregisteredCapability(t *testing.T) {
	registry := capability.New()

	_, err := registry.Invoke(context.Background(), "container.remove", nil)

	if !errors.Is(err, capability.ErrUnsupported) {
		t.Fatalf("error = %v, want ErrUnsupported", err)
	}
}

func TestInvokeAppliesThePerCapabilityTimeout(t *testing.T) {
	registry := capability.New()

	registry.Register(capability.Definition{
		Name:    capability.HostMetrics,
		Timeout: 20 * time.Millisecond,
		Handler: func(ctx context.Context, _ json.RawMessage) (any, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})

	_, err := registry.Invoke(context.Background(), capability.HostMetrics, nil)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want DeadlineExceeded", err)
	}

	if code := capability.Code(err); code != "AGENT_REQUEST_EXPIRED" {
		t.Errorf("code = %q, want AGENT_REQUEST_EXPIRED", code)
	}
}

func TestRegisteringTheSameCapabilityTwicePanics(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("expected a duplicate registration to panic")
		}
	}()

	registry := capability.New()
	definition := capability.Definition{
		Name:    capability.HostInventory,
		Timeout: time.Second,
		Handler: func(context.Context, json.RawMessage) (any, error) { return nil, nil },
	}

	registry.Register(definition)
	registry.Register(definition)
}

func TestTheAdvertisedSetIsExactlyTheDefinedCapabilities(t *testing.T) {
	registry := capability.New()
	capability.Register(registry, capability.Sources{})

	// Six reads, three named container operations and one log stream. The list
	// is exhaustive: anything absent here cannot be invoked, whatever the
	// server asks for.
	expected := []string{
		"compose.inspect",
		"compose.list",
		"container.inspect",
		"container.list",
		"container.logs",
		"container.restart",
		"container.start",
		"container.stop",
		"host.inventory",
		"host.metrics",
	}

	names := registry.Names()

	if len(names) != len(expected) {
		t.Fatalf("capabilities = %v, want %v", names, expected)
	}

	for index, name := range expected {
		if names[index] != name {
			t.Fatalf("capabilities = %v, want %v", names, expected)
		}
	}
}

/*
The forbidden set is asserted explicitly, so adding one of these fails a test
rather than passing unnoticed.

Container start, stop and restart left this list by a product decision that came
with a permission, an audit trail and a confirmation, and container.logs left it
the same way: it reads output and carries no input. Nothing else has, and in
particular there is no capability that takes an operation name or a command.
*/
func TestNoForbiddenCapabilityIsRegistered(t *testing.T) {
	registry := capability.New()
	capability.Register(registry, capability.Sources{})

	forbidden := map[string]bool{
		"container.remove": true, "container.exec": true, "container.attach": true,
		"container.kill": true, "container.pause": true, "container.update": true,
		"compose.up": true, "compose.down": true, "compose.deploy": true,
		"image.pull": true, "volume.remove": true, "network.remove": true,
		"host.reboot": true, "shell": true, "exec": true, "docker.command": true,
		"container.action": true,
	}

	for _, name := range registry.Names() {
		if forbidden[name] {
			t.Fatalf("a mutating capability is registered: %s", name)
		}
	}
}
