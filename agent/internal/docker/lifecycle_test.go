package docker_test

import (
	"context"
	"errors"
	"testing"

	"github.com/docker/docker/api/types/container"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

func running() container.InspectResponse {
	return container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID:    "aaa111",
			State: &container.State{Status: "running", Running: true, StartedAt: "2026-08-10T10:00:00Z"},
		},
	}
}

func stopped() container.InspectResponse {
	return container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID:    "aaa111",
			State: &container.State{Status: "exited", Running: false},
		},
	}
}

/*
Container lifecycle against the Engine API.

What matters here is which Docker call each operation makes, that it makes
exactly one, and that a refusal is separated from a failure — the control server
reports them differently and an operator reads them differently.
*/
func TestStartStartsAStoppedContainer(t *testing.T) {
	client := &fakeClient{inspect: stopped()}
	engine := docker.NewEngine(client)

	result, err := engine.Start(context.Background(), "aaa111")

	if err != nil {
		t.Fatalf("start: %v", err)
	}

	if len(client.calls) != 1 || client.calls[0] != "start:aaa111" {
		t.Fatalf("calls = %v, want exactly one start", client.calls)
	}

	if result.DockerID != "aaa111" {
		t.Errorf("docker id = %q", result.DockerID)
	}
}

/*
A container that is already running is refused.

Reporting success would put "started" in the audit trail for something this call
did not start, and would tell an operator their action had an effect it did not.
*/
func TestStartRefusesARunningContainer(t *testing.T) {
	client := &fakeClient{inspect: running()}
	engine := docker.NewEngine(client)

	_, err := engine.Start(context.Background(), "aaa111")

	if !errors.Is(err, docker.ErrAlreadyRunning) {
		t.Fatalf("error = %v, want ErrAlreadyRunning", err)
	}

	if len(client.calls) != 0 {
		t.Fatalf("calls = %v, want none", client.calls)
	}
}

func TestStopStopsARunningContainer(t *testing.T) {
	client := &fakeClient{inspect: running()}
	engine := docker.NewEngine(client)

	if _, err := engine.Stop(context.Background(), "aaa111"); err != nil {
		t.Fatalf("stop: %v", err)
	}

	// The timeout is the agent's, not something a caller chose.
	if len(client.calls) != 1 || client.calls[0] != "stop:aaa111:30" {
		t.Fatalf("calls = %v, want one stop with the fixed timeout", client.calls)
	}
}

func TestStopRefusesAContainerThatIsNotRunning(t *testing.T) {
	client := &fakeClient{inspect: stopped()}
	engine := docker.NewEngine(client)

	_, err := engine.Stop(context.Background(), "aaa111")

	if !errors.Is(err, docker.ErrAlreadyStopped) {
		t.Fatalf("error = %v, want ErrAlreadyStopped", err)
	}

	if len(client.calls) != 0 {
		t.Fatalf("calls = %v, want none", client.calls)
	}
}

/*
Restart is one Docker call.

Sequencing a stop and a start here would open a window in which the container is
down and nothing is recorded as running, and a failure between them would leave
the trail describing a restart that actually stopped something.
*/
func TestRestartIsASingleDockerOperation(t *testing.T) {
	client := &fakeClient{inspect: running()}
	engine := docker.NewEngine(client)

	if _, err := engine.Restart(context.Background(), "aaa111"); err != nil {
		t.Fatalf("restart: %v", err)
	}

	if len(client.calls) != 1 || client.calls[0] != "restart:aaa111:30" {
		t.Fatalf("calls = %v, want one restart", client.calls)
	}

	for _, call := range client.calls {
		if call == "stop:aaa111:30" || call == "start:aaa111" {
			t.Fatalf("restart was composed from %s", call)
		}
	}
}

func TestRestartWorksOnAStoppedContainer(t *testing.T) {
	client := &fakeClient{inspect: stopped()}
	engine := docker.NewEngine(client)

	// Docker starts a stopped container on restart, and the agent does not
	// second-guess it: the operator asked for the container to be running.
	if _, err := engine.Restart(context.Background(), "aaa111"); err != nil {
		t.Fatalf("restart: %v", err)
	}

	if len(client.calls) != 1 {
		t.Fatalf("calls = %v, want one restart", client.calls)
	}
}

func TestLifecycleReportsAMissingContainer(t *testing.T) {
	client := &fakeClient{inspectErr: errors.New("Error: No such container: aaa111")}
	engine := docker.NewEngine(client)

	if _, err := engine.Start(context.Background(), "aaa111"); err == nil {
		t.Fatal("expected a missing container to be reported")
	}
}

func TestLifecycleReportsARefusedDaemon(t *testing.T) {
	client := &fakeClient{inspect: stopped(), startErr: errors.New("permission denied")}
	engine := docker.NewEngine(client)

	_, err := engine.Start(context.Background(), "aaa111")

	if !errors.Is(err, docker.ErrPermission) {
		t.Fatalf("error = %v, want ErrPermission", err)
	}
}

func TestLifecycleReportsAnUnreachableDaemon(t *testing.T) {
	client := &fakeClient{inspectErr: errors.New("cannot connect to the Docker daemon")}
	engine := docker.NewEngine(client)

	_, err := engine.Stop(context.Background(), "aaa111")

	if !errors.Is(err, docker.ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func TestLifecycleObservesTheStateDockerReports(t *testing.T) {
	client := &fakeClient{inspect: running()}
	engine := docker.NewEngine(client)

	result, err := engine.Restart(context.Background(), "aaa111")

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	// The result is what Docker said afterwards, not what was asked for.
	if result.State != "running" {
		t.Errorf("state = %q, want running", result.State)
	}

	if result.StartedAt == "" {
		t.Error("the observation carries no start time")
	}

	if result.ObservedAt.IsZero() {
		t.Error("the observation carries no time")
	}
}

func TestLifecycleStopsWhenTheContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	client := &fakeClient{inspect: stopped(), startErr: ctx.Err()}
	engine := docker.NewEngine(client)

	if _, err := engine.Start(ctx, "aaa111"); err == nil {
		t.Fatal("expected a cancelled context to abort the operation")
	}
}
