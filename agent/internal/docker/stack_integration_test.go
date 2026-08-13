//go:build docker_integration

package docker_test

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Deploying a stack onto a real Docker daemon.

Two services, a volume and a network, created by the product code and read back
with the Docker CLI — which is the harness's own channel and not the code under
test. What is being checked is the part that only exists on a real daemon: that
the containers carry the stack identity, that they are attached to the network
the plan asked for, that the volume is created and labelled, and that a
deployment which fails part-way leaves what it already made exactly where it is.

Ownership is proven the same way as everywhere else in this package. Every
resource is named after this run, registered with the harness, and removed
afterwards.
*/

func stackPlan(t *testing.T, stackID string, purpose string) *docker.StackPlan {
	t.Helper()

	project := containerName(purpose)

	return &docker.StackPlan{
		PlanVersion: docker.StackPlanVersion,
		StackID:     stackID,
		RevisionID:  "revision-" + runID,
		ProjectName: project,
		Networks: []docker.StackNetwork{
			{Name: "default", DockerName: project + "_default"},
		},
		Volumes: []docker.StackVolume{
			{Name: "data", DockerName: project + "_data"},
		},
		Services: []docker.StackService{
			{
				ServiceName:   "web",
				ContainerID:   "resource-web-" + runID,
				ContainerName: project + "-web-1",
				DependsOn:     []string{"database"},
				Spec: docker.ContainerSpec{
					Image:    testImage,
					Command:  []string{"sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done"},
					Networks: []string{project + "_default"},
					Labels:   map[string]string{e2eLabel: "true", e2eRunLabel: runID},
				},
			},
			{
				ServiceName:   "database",
				ContainerID:   "resource-db-" + runID,
				ContainerName: project + "-database-1",
				Spec: docker.ContainerSpec{
					Image:   testImage,
					Command: []string{"sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done"},
					Mounts: []docker.MountSpec{
						{Type: "volume", Source: project + "_data", Target: "/data"},
					},
					Networks: []string{project + "_default"},
					Labels:   map[string]string{e2eLabel: "true", e2eRunLabel: runID},
				},
			},
		},
	}
}

/** Removes everything a plan may have created, whatever the test did. */
func cleanUpStack(t *testing.T, plan *docker.StackPlan) {
	t.Helper()

	t.Cleanup(func() {
		for _, service := range plan.Services {
			delete(created, service.ContainerName)
			_ = exec.Command("docker", "rm", "-f", service.ContainerName).Run()
		}

		for _, volume := range plan.Volumes {
			_ = exec.Command("docker", "volume", "rm", "-f", volume.DockerName).Run()
		}

		for _, network := range plan.Networks {
			_ = exec.Command("docker", "network", "rm", network.DockerName).Run()
		}
	})
}

func TestStackDeploysOntoARealDaemon(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	plan := stackPlan(t, "stack-"+runID, "stack")
	cleanUpStack(t, plan)

	result, err := engine.DeployStack(ctx, plan)

	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	if !result.Complete {
		t.Fatalf("incomplete: %+v", result.Services)
	}

	// The dependency first, which is the order the plan asked for.
	if result.Services[0].ServiceName != "database" {
		t.Errorf("started %s first", result.Services[0].ServiceName)
	}

	for _, outcome := range result.Services {
		if outcome.State != "running" {
			t.Errorf("%s is %s", outcome.ServiceName, outcome.State)
		}

		adopt(t, plan.Services[0].ContainerName, outcome.DockerID)
	}

	for _, service := range plan.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))

		if identity := label(t, service.ContainerName, docker.LabelStackID); identity != plan.StackID {
			t.Errorf("%s carries stack %q", service.ServiceName, identity)
		}

		if service := label(t, service.ContainerName, docker.LabelStackService); service == "" {
			t.Error("a container carries no service name")
		}

		attached := inspect(t, service.ContainerName, "{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}")

		if !strings.Contains(attached, plan.Networks[0].DockerName) {
			t.Errorf("%s is on %q", service.ServiceName, attached)
		}
	}

	// The volume exists and says which stack made it, which is what stops the
	// next deployment from adopting somebody else's.
	labels := run(t, "volume", "inspect", plan.Volumes[0].DockerName, "--format",
		`{{index .Labels "`+docker.LabelStackID+`"}}`)

	if labels != plan.StackID {
		t.Errorf("the volume carries stack %q", labels)
	}
}

/*
A stack that cannot have the name it wants.

The container is created outside the harness with no Dockplane labels, which is
what a container somebody else runs looks like. Nothing may be renamed, removed
or adopted on the strength of the name matching.
*/
func TestStackRefusesARealContainerItDoesNotOwn(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	plan := stackPlan(t, "stack-conflict-"+runID, "conflict")
	cleanUpStack(t, plan)

	foreignContainer(t, plan.Services[0].ContainerName)

	if _, err := engine.DeployStack(ctx, plan); err == nil {
		t.Fatal("a stack was deployed over a container it does not own")
	}

	// The foreign container is untouched, and nothing else was created.
	if state := inspect(t, plan.Services[0].ContainerName, "{{.State.Status}}"); state != "created" {
		t.Errorf("the foreign container is now %s", state)
	}

	if exists(t, "volume", plan.Volumes[0].DockerName) {
		t.Error("a volume was created for a deployment that could not run")
	}

	if exists(t, "network", plan.Networks[0].DockerName) {
		t.Error("a network was created for a deployment that could not run")
	}
}

/*
An image that does not exist stops the deployment before the host changes.

The commonest way a real deployment fails, and the one where creating the
network first would leave litter behind on somebody's machine.
*/
func TestStackWithAnUnavailableImageChangesNothing(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	plan := stackPlan(t, "stack-image-"+runID, "image")
	plan.Services[1].Spec.Image = "dockplane.invalid/no-such-image:" + runID
	cleanUpStack(t, plan)

	if _, err := engine.DeployStack(ctx, plan); err == nil {
		t.Fatal("a stack with an unavailable image was deployed")
	}

	for _, service := range plan.Services {
		if exists(t, "container", service.ContainerName) {
			t.Errorf("%s was created", service.ServiceName)
		}
	}

	if exists(t, "volume", plan.Volumes[0].DockerName) {
		t.Error("a volume was created")
	}

	if exists(t, "network", plan.Networks[0].DockerName) {
		t.Error("a network was created")
	}
}

/** Reads one field off a container, through the harness's own channel. */
func inspect(t *testing.T, name string, format string) string {
	t.Helper()

	return run(t, "inspect", name, "--format", format)
}

func label(t *testing.T, name string, key string) string {
	t.Helper()

	return inspect(t, name, `{{index .Config.Labels "`+key+`"}}`)
}

/** Whether a Docker resource of that kind and name exists. */
func exists(t *testing.T, kind string, name string) bool {
	t.Helper()

	arguments := []string{kind, "inspect", name}

	if kind == "container" {
		arguments = []string{"inspect", name}
	}

	return exec.Command("docker", arguments...).Run() == nil
}
