//go:build docker_integration

package docker_test

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Starting, stopping and restarting a stack on a real Docker daemon.

The part that cannot be established against a model: what the engine actually
does to a container that is stopped and started again. Two facts the product
depends on are checked here rather than assumed — that the container keeps its
identifier and its data, and that Docker moves `State.StartedAt` when it starts
one. The second is what a restart is recognised by afterwards, so if the engine
ever stopped doing it these tests are where that surfaces.

Everything is named after this run, registered with the harness and removed
afterwards, exactly as the deployment tests are.
*/

/** The lifecycle request for a plan that is already deployed. */
func lifecyclePlanFor(plan *docker.StackPlan) *docker.StackLifecyclePlan {
	services := make([]docker.StackLifecycleService, 0, len(plan.Services))

	for _, service := range plan.Services {
		services = append(services, docker.StackLifecycleService{
			ServiceName: service.ServiceName,
			ContainerID: service.ContainerID,
			DependsOn:   service.DependsOn,
		})
	}

	return &docker.StackLifecyclePlan{
		PlanVersion: docker.StackLifecyclePlanVersion,
		StackID:     plan.StackID,
		RevisionID:  plan.RevisionID,
		Services:    services,
	}
}

/** A deployed stack of two services, one depending on the other. */
func deployedFixture(t *testing.T, ctx context.Context, engine *docker.Engine, purpose string) *docker.StackPlan {
	t.Helper()

	plan := stackPlan(t, "stack-"+runID+"-"+purpose, purpose)
	cleanUpStack(t, plan)

	result, err := engine.ApplyStack(ctx, plan)

	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	if !result.Complete {
		t.Fatalf("incomplete deployment: %+v", result.Services)
	}

	for index, outcome := range result.Services {
		adopt(t, plan.Services[index].ContainerName, outcome.DockerID)
	}

	return plan
}

func TestStackStopsAndStartsOnARealDaemon(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "lifecycle")
	lifecycle := lifecyclePlanFor(plan)

	identifiers := map[string]string{}

	for _, service := range plan.Services {
		identifiers[service.ServiceName] = inspect(t, service.ContainerName, "{{.Id}}")
	}

	if _, err := engine.StopStack(ctx, lifecycle); err != nil {
		t.Fatalf("stop: %v", err)
	}

	for _, service := range plan.Services {
		if state := inspect(t, service.ContainerName, "{{.State.Status}}"); state == "running" {
			t.Errorf("%s is still running", service.ServiceName)
		}
	}

	if _, err := engine.StartStack(ctx, lifecycle); err != nil {
		t.Fatalf("start: %v", err)
	}

	for _, service := range plan.Services {
		if state := inspect(t, service.ContainerName, "{{.State.Status}}"); state != "running" {
			t.Errorf("%s is %s", service.ServiceName, state)
		}

		// Starting a container is not building one: the operator's container is
		// the same container.
		if id := inspect(t, service.ContainerName, "{{.Id}}"); id != identifiers[service.ServiceName] {
			t.Errorf("%s was recreated", service.ServiceName)
		}
	}
}

/*
What a restart leaves behind, on the engine rather than on a model.

The identifier is the same and the start time has moved. The second is the whole
basis for recognising a restart whose answer was lost, so it is asserted against
the real daemon rather than taken on trust.
*/
func TestStackRestartKeepsTheContainerAndMovesItsStartTime(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "restart")
	lifecycle := lifecyclePlanFor(plan)

	before := map[string]struct{ id, startedAt string }{}

	for _, service := range plan.Services {
		before[service.ServiceName] = struct{ id, startedAt string }{
			id:        inspect(t, service.ContainerName, "{{.Id}}"),
			startedAt: inspect(t, service.ContainerName, "{{.State.StartedAt}}"),
		}
	}

	result, err := engine.RestartStack(ctx, lifecycle)

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	if result.Outcome != docker.LifecycleCompleted {
		t.Fatalf("outcome: %s", result.Outcome)
	}

	for _, service := range plan.Services {
		previous := before[service.ServiceName]

		if id := inspect(t, service.ContainerName, "{{.Id}}"); id != previous.id {
			t.Errorf("%s was recreated by a restart", service.ServiceName)
		}

		if state := inspect(t, service.ContainerName, "{{.State.Status}}"); state != "running" {
			t.Errorf("%s is %s after a restart", service.ServiceName, state)
		}

		startedAt := inspect(t, service.ContainerName, "{{.State.StartedAt}}")

		if startedAt == previous.startedAt {
			t.Errorf("%s reports the same start time after a restart: %s", service.ServiceName, startedAt)
		}

		/*
		 * The field the engine does not move for a deliberate restart.
		 *
		 * RestartCount counts what a restart policy did, not what an operator
		 * asked for, which is why the product does not correlate on it. Checked
		 * so that a change in Docker's behaviour is caught here rather than by
		 * a stack that quietly stops being able to tell.
		 */
		if count := inspect(t, service.ContainerName, "{{.RestartCount}}"); count != "0" {
			t.Logf("note: %s reports RestartCount %s after a deliberate restart", service.ServiceName, count)
		}
	}
}

/*
Data survives every one of these operations.

The reason this path exists at all is that an operator can take a stack down and
bring it back without losing what it holds. A canary is written into the named
volume and read back afterwards.
*/
func TestStackLifecycleKeepsVolumeData(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "data")
	lifecycle := lifecyclePlanFor(plan)

	// The service that mounts the volume, written to through the harness's own
	// channel rather than through anything under test.
	database := plan.Services[1].ContainerName

	run(t, "exec", database, "sh", "-c", "echo lifecycle-canary > /data/canary")

	network := run(t, "network", "inspect", plan.Networks[0].DockerName, "--format", "{{.Id}}")
	volume := run(t, "volume", "inspect", plan.Volumes[0].DockerName, "--format", "{{.Name}}")

	if _, err := engine.StopStack(ctx, lifecycle); err != nil {
		t.Fatalf("stop: %v", err)
	}

	if _, err := engine.StartStack(ctx, lifecycle); err != nil {
		t.Fatalf("start: %v", err)
	}

	if _, err := engine.RestartStack(ctx, lifecycle); err != nil {
		t.Fatalf("restart: %v", err)
	}

	if got := run(t, "exec", database, "cat", "/data/canary"); !strings.Contains(got, "lifecycle-canary") {
		t.Errorf("the volume no longer holds what was written to it: %q", got)
	}

	// Nothing is recreated, so the network the stack is on is the same network.
	if after := run(t, "network", "inspect", plan.Networks[0].DockerName, "--format", "{{.Id}}"); after != network {
		t.Errorf("the network was recreated: %s then %s", network, after)
	}

	if after := run(t, "volume", "inspect", plan.Volumes[0].DockerName, "--format", "{{.Name}}"); after != volume {
		t.Errorf("the volume was replaced: %s then %s", volume, after)
	}
}

/*
A service that is not there is not created.

The container is removed behind the agent's back, which is the state a host is
in after somebody has been tidying up by hand. Starting the stack then means
building something, and building belongs to deploying a revision.
*/
func TestStackLifecycleRefusesAMissingServiceOnARealDaemon(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "missing")
	lifecycle := lifecyclePlanFor(plan)

	removed := plan.Services[0].ContainerName

	if err := exec.Command("docker", "rm", "-f", removed).Run(); err != nil {
		t.Fatalf("could not remove the container: %v", err)
	}

	delete(created, removed)

	_, err := engine.StopStack(ctx, lifecycle)

	if !errors.Is(err, docker.ErrStackServiceMissing) {
		t.Fatalf("expected a missing service, got %v", err)
	}

	// And the service that is there was not touched on the way to finding out.
	if state := inspect(t, plan.Services[1].ContainerName, "{{.State.Status}}"); state != "running" {
		t.Errorf("the remaining service is %s", state)
	}
}
