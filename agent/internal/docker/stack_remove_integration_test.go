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
Removing a stack from a real Docker daemon.

The tests that matter most in this file are the ones about what is still there
afterwards. A named volume with data in it, a network, and any container that
was never this stack's: all of them have to survive an operation whose name
suggests otherwise, and only a real daemon can show that they do.
*/

func TestRemoveStackTakesTheContainersAndKeepsTheData(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "remove")
	lifecycle := lifecyclePlanFor(plan)

	// Written through the harness's own channel, into the volume the stack
	// mounts, before anything is removed.
	database := plan.Services[1].ContainerName

	run(t, "exec", database, "sh", "-c", "echo delete-canary > /data/canary")

	result, err := engine.RemoveStack(ctx, lifecycle)

	if err != nil {
		t.Fatalf("remove: %v", err)
	}

	if result.Outcome != docker.RemoveCompleted {
		t.Fatalf("outcome: %s", result.Outcome)
	}

	for _, service := range plan.Services {
		if exists(t, "container", service.ContainerName) {
			t.Errorf("%s is still on the host", service.ServiceName)
		}

		delete(created, service.ContainerName)
	}

	// The whole reason this operation is careful.
	if !exists(t, "volume", plan.Volumes[0].DockerName) {
		t.Fatal("the named volume was removed with the stack")
	}

	if !exists(t, "network", plan.Networks[0].DockerName) {
		t.Error("the network was removed, which this version does not do")
	}

	/*
	 * And the data is still in it. Read by mounting the volume into a
	 * throwaway container, because the containers that held it are gone.
	 */
	reader := containerName("canary-reader")

	adopt(t, reader, run(t,
		"run", "-d", "--name", reader,
		"--label", e2eLabel+"=true", "--label", e2eRunLabel+"="+runID,
		"-v", plan.Volumes[0].DockerName+":/data",
		testImage, "sh", "-c", "sleep 60",
	))

	if got := run(t, "exec", reader, "cat", "/data/canary"); !strings.Contains(got, "delete-canary") {
		t.Errorf("the retained volume no longer holds what was written to it: %q", got)
	}
}

/* A stopped stack is removed without being started first. */
func TestRemoveStackRemovesAStoppedStack(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "removestopped")
	lifecycle := lifecyclePlanFor(plan)

	if _, err := engine.StopStack(ctx, lifecycle); err != nil {
		t.Fatalf("stop: %v", err)
	}

	if _, err := engine.RemoveStack(ctx, lifecycle); err != nil {
		t.Fatalf("remove: %v", err)
	}

	for _, service := range plan.Services {
		if exists(t, "container", service.ContainerName) {
			t.Errorf("%s is still on the host", service.ServiceName)
		}

		delete(created, service.ContainerName)
	}

	if !exists(t, "volume", plan.Volumes[0].DockerName) {
		t.Fatal("the named volume was removed with the stack")
	}
}

/*
A container that is not this stack's is not touched.

The one that would be destroyed by a removal keyed on names rather than on the
identity Dockplane wrote. It is given a name in the same family and none of the
labels, which is exactly what somebody else's container looks like.
*/
func TestRemoveStackLeavesAForeignContainerAlone(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "foreign")
	lifecycle := lifecyclePlanFor(plan)

	foreign := plan.ProjectName + "-web-2"

	adopt(t, foreign, run(t,
		"run", "-d", "--name", foreign,
		"--label", e2eLabel+"=true", "--label", e2eRunLabel+"="+runID,
		testImage, "sh", "-c", "sleep 120",
	))

	if _, err := engine.RemoveStack(ctx, lifecycle); err != nil {
		t.Fatalf("remove: %v", err)
	}

	if !exists(t, "container", foreign) {
		t.Fatal("a container that was not this stack's was removed with it")
	}

	if state := inspect(t, foreign, "{{.State.Status}}"); state != "running" {
		t.Errorf("the foreign container is %s", state)
	}

	for _, service := range plan.Services {
		delete(created, service.ContainerName)
	}
}

/*
A volume left behind by a deleted stack is not adopted by a new one.

The data-safety case that makes retention safe at all: after a deletion the
volume still carries the old stack's identity, and a new stack of the same name
is a different identity. Deploying it must stop rather than mount somebody
else's data.
*/
func TestDeployRefusesAVolumeLeftByAnotherStack(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "reuse")
	lifecycle := lifecyclePlanFor(plan)

	if _, err := engine.RemoveStack(ctx, lifecycle); err != nil {
		t.Fatalf("remove: %v", err)
	}

	for _, service := range plan.Services {
		delete(created, service.ContainerName)
	}

	if !exists(t, "volume", plan.Volumes[0].DockerName) {
		t.Fatal("the volume did not survive the removal")
	}

	/*
	 * A new stack: same project name, same Docker names, different identity —
	 * which is what creating a stack of the same name again produces.
	 */
	replacement := stackPlan(t, "stack-"+runID+"-reuse-2", "reuse")
	replacement.RevisionID = "revision-" + runID + "-2"

	for index := range replacement.Services {
		replacement.Services[index].ContainerID = "resource-new-" + runID + "-" + replacement.Services[index].ServiceName
	}

	cleanUpStack(t, replacement)

	_, err := engine.ApplyStack(ctx, replacement)

	if !errors.Is(err, docker.ErrStackResourceConflict) {
		t.Fatalf("expected the volume to be refused as somebody else's, got %v", err)
	}

	// And it was refused before anything was built.
	for _, service := range replacement.Services {
		if exists(t, "container", service.ContainerName) {
			t.Errorf("%s was created despite the conflict", service.ServiceName)
		}
	}
}

/* A service that is gone stops the removal before anything else is taken. */
func TestRemoveStackRefusesAMissingServiceOnARealDaemon(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	plan := deployedFixture(t, ctx, engine, "removemissing")
	lifecycle := lifecyclePlanFor(plan)

	removed := plan.Services[0].ContainerName

	if err := exec.Command("docker", "rm", "-f", removed).Run(); err != nil {
		t.Fatalf("could not remove the container: %v", err)
	}

	delete(created, removed)

	_, err := engine.RemoveStack(ctx, lifecycle)

	if !errors.Is(err, docker.ErrStackServiceMissing) {
		t.Fatalf("expected a missing service, got %v", err)
	}

	if !exists(t, "container", plan.Services[1].ContainerName) {
		t.Error("the remaining service was removed on the way to finding out")
	}
}
