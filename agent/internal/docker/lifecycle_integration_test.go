//go:build docker_integration

// Lifecycle against a real Docker daemon. Excluded from the default build:
//
//	go test -tags docker_integration ./internal/docker/
//
// Every operation goes through the guarded helpers below, which refuse anything
// this run did not create and label. See e2e_harness_test.go for why.
package docker_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

func lifecycleContext(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()

	return context.WithTimeout(context.Background(), 90*time.Second)
}

/*
The only way these tests change a container.

Ownership is proven immediately before the call rather than at creation, so a
container that was replaced, relabelled or removed in between stops the test
instead of being operated on.
*/
func start(t *testing.T, engine *docker.Engine, name string) (*docker.LifecycleResult, error) {
	t.Helper()
	mustOwn(t, name)

	ctx, cancel := lifecycleContext(t)
	defer cancel()

	return engine.Start(ctx, name)
}

func stop(t *testing.T, engine *docker.Engine, name string) (*docker.LifecycleResult, error) {
	t.Helper()
	mustOwn(t, name)

	ctx, cancel := lifecycleContext(t)
	defer cancel()

	return engine.Stop(ctx, name)
}

func restart(t *testing.T, engine *docker.Engine, name string) (*docker.LifecycleResult, error) {
	t.Helper()
	mustOwn(t, name)

	ctx, cancel := lifecycleContext(t)
	defer cancel()

	return engine.Restart(ctx, name)
}

// lifecycleContainer creates the container a lifecycle test operates on.
func lifecycleContainer(t *testing.T) string {
	t.Helper()

	name, _ := createContainer(t, "lifecycle")

	return name
}

func TestStopThenStartMovesARealContainer(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := lifecycleContainer(t)

	stopped, err := stop(t, engine, name)

	if err != nil {
		t.Fatalf("stop: %v", err)
	}

	if stopped.State == "running" {
		t.Errorf("state = %q, want the container to have stopped", stopped.State)
	}

	started, err := start(t, engine, name)

	if err != nil {
		t.Fatalf("start: %v", err)
	}

	if started.State != "running" {
		t.Errorf("state = %q, want running", started.State)
	}
}

/*
A refusal is not a failure, and it is decided by the daemon's answer.

Docker itself is content to stop a stopped container; reporting that as a
success would put "stopped" in the audit trail for something this call did not
stop.
*/
func TestRealContainerRefusesAnOperationThatDoesNotApply(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := lifecycleContainer(t)

	if _, err := start(t, engine, name); !errors.Is(err, docker.ErrAlreadyRunning) {
		t.Fatalf("start of a running container: error = %v, want ErrAlreadyRunning", err)
	}

	if _, err := stop(t, engine, name); err != nil {
		t.Fatalf("stop: %v", err)
	}

	if _, err := stop(t, engine, name); !errors.Is(err, docker.ErrAlreadyStopped) {
		t.Fatalf("stop of a stopped container: error = %v, want ErrAlreadyStopped", err)
	}
}

func TestRestartLeavesARealContainerRunning(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := lifecycleContainer(t)

	before, err := restart(t, engine, name)

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	if before.State != "running" {
		t.Errorf("state = %q, want running", before.State)
	}

	// A second restart has to move the start time. A restart that reported
	// success without the container having gone through one would leave the
	// audit trail describing something that did not happen.
	after, err := restart(t, engine, name)

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	if after.StartedAt == before.StartedAt {
		t.Error("the container was not actually restarted: its start time did not move")
	}
}

/*
An operation reaches one container and no other.

The agent is given an identifier, and the Engine API acts on that identifier
alone. This is the guarantee that matters most on a host running real
workloads, so it is asserted against the daemon rather than trusted.
*/
func TestLifecycleTouchesNothingElseOnTheHost(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := lifecycleContainer(t)
	bystander, _ := createContainer(t, "bystander")

	before := containerStates(t, engine, name)

	if _, err := restart(t, engine, name); err != nil {
		t.Fatalf("restart: %v", err)
	}

	if _, err := stop(t, engine, name); err != nil {
		t.Fatalf("stop: %v", err)
	}

	after := containerStates(t, engine, name)

	for container, state := range before {
		if after[container] != state {
			t.Errorf("%s changed from %q to %q", container, state, after[container])
		}
	}

	for container, state := range after {
		if _, present := before[container]; !present {
			t.Errorf("%s appeared in state %q", container, state)
		}
	}

	// The bystander belongs to this run and is still covered by the sweep
	// above, so a stray operation on it would be reported by name.
	if after[bystander] != "running" {
		t.Errorf("%s is %q, want running", bystander, after[bystander])
	}
}

/*
A container that is not there cannot be operated on.

This deliberately reaches the engine without the ownership guard, because the
guard would refuse a name it never created. It is safe precisely because the
name is proven absent first: there is nothing on the host for the call to
change.
*/
func TestLifecycleReportsAContainerThatIsNotThere(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name := containerName("absent")

	if _, err := inspectOwnership(name); err == nil {
		t.Fatalf("%s exists; the test would operate on a container it does not own", name)
	}

	ctx, cancel := lifecycleContext(t)
	defer cancel()

	if _, err := engine.Start(ctx, name); err == nil {
		t.Fatal("expected a missing container to be reported")
	}
}
