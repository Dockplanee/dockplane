package gateway

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/protocol"
)

/*
Replay protection for operations that change a host.

The guard existed while every capability was read-only, where repeating one was
harmless. It is now the difference between restarting a container once and
restarting it twice, so the property is demonstrated rather than assumed: the
same request identifier reaches the handler once, whatever arrives on the wire.
*/
func TestARepeatedRequestNeverReachesTheHandlerTwice(t *testing.T) {
	var invocations atomic.Int32

	registry := capability.New()
	registry.Register(capability.Definition{
		Name:    capability.ContainerRestart,
		Timeout: time.Second,
		Handler: func(context.Context, json.RawMessage) (any, error) {
			invocations.Add(1)
			return map[string]string{"state": "running"}, nil
		},
	})

	client := New(Options{Registry: registry, Logger: slog.New(slog.DiscardHandler)})

	request := &protocol.ServerMessage{
		Type:            protocol.TypeRequest,
		ProtocolVersion: protocol.Version,
		ID:              "11111111-1111-4111-8111-111111111111",
		Capability:      capability.ContainerRestart,
		IssuedAt:        time.Now().Format(time.RFC3339),
		ExpiresAt:       time.Now().Add(time.Minute).Format(time.RFC3339),
		Payload:         json.RawMessage(`{"containerId":"aaa111"}`),
	}

	client.handleRequest(context.Background(), request)
	client.handleRequest(context.Background(), request)

	if got := invocations.Load(); got != 1 {
		t.Fatalf("the handler ran %d times, want exactly 1", got)
	}
}

/*
An expired request is never carried out.

A restart that waited in a queue, or was replayed after a reconnect, must not
run against a host whose state has moved on since it was issued.
*/
func TestAnExpiredRequestIsNeverCarriedOut(t *testing.T) {
	var invocations atomic.Int32

	registry := capability.New()
	registry.Register(capability.Definition{
		Name:    capability.ContainerStop,
		Timeout: time.Second,
		Handler: func(context.Context, json.RawMessage) (any, error) {
			invocations.Add(1)
			return nil, nil
		},
	})

	client := New(Options{Registry: registry, Logger: slog.New(slog.DiscardHandler)})

	issued := time.Now().Add(-5 * time.Minute)

	client.handleRequest(context.Background(), &protocol.ServerMessage{
		Type:            protocol.TypeRequest,
		ProtocolVersion: protocol.Version,
		ID:              "22222222-2222-4222-8222-222222222222",
		Capability:      capability.ContainerStop,
		IssuedAt:        issued.Format(time.RFC3339),
		ExpiresAt:       issued.Add(time.Minute).Format(time.RFC3339),
		Payload:         json.RawMessage(`{"containerId":"aaa111"}`),
	})

	if got := invocations.Load(); got != 0 {
		t.Fatalf("an expired request ran %d times, want 0", got)
	}
}

/*
A capability the agent does not implement runs nothing.

The registry is the only way in, so a server asking for something outside it —
by mistake or otherwise — reaches no handler at all.
*/
func TestAnUnknownCapabilityRunsNothing(t *testing.T) {
	var invocations atomic.Int32

	registry := capability.New()
	registry.Register(capability.Definition{
		Name:    capability.ContainerStart,
		Timeout: time.Second,
		Handler: func(context.Context, json.RawMessage) (any, error) {
			invocations.Add(1)
			return nil, nil
		},
	})

	client := New(Options{Registry: registry, Logger: slog.New(slog.DiscardHandler)})

	for _, name := range []string{"container.remove", "container.exec", "docker.command"} {
		client.handleRequest(context.Background(), &protocol.ServerMessage{
			Type:            protocol.TypeRequest,
			ProtocolVersion: protocol.Version,
			ID:              "33333333-3333-4333-8333-33333333333" + name[len(name)-1:],
			Capability:      name,
			IssuedAt:        time.Now().Format(time.RFC3339),
			ExpiresAt:       time.Now().Add(time.Minute).Format(time.RFC3339),
			Payload:         json.RawMessage(`{"containerId":"aaa111"}`),
		})
	}

	if got := invocations.Load(); got != 0 {
		t.Fatalf("a handler ran %d times for capabilities that are not registered", got)
	}
}
