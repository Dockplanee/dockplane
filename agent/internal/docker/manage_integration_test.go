//go:build docker_integration

package docker_test

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Creating, replacing and removing real containers.

The other integration tests operate containers the harness made with the Docker
CLI. These are the ones where the product code makes them itself, which is the
only way to check the things that only exist at creation: which labels a
container ends up carrying, that a replacement is a different container under
the same name, and — the one that matters most — that a volume and everything
in it survives both.

Ownership still has to be provable. A container these tests build carries the
suite labels in its own specification, and is registered with the harness so the
same refusal-to-touch-anything-else rules apply to it as to the rest.
*/

const managedSecret = "PLEASE-DO-NOT-TRANSMIT-THIS-VALUE-EITHER"

/*
A specification for a container this run owns.

The suite labels go in the caller's own labels, which is allowed: they are not
in the io.dockplane namespace the agent reserves for itself. So a container the
product built is still recognisably this run's, and the ownership check that
guards every operation applies to it unchanged.
*/
func ownedSpec(purpose string) *docker.ContainerSpec {
	return &docker.ContainerSpec{
		Name:  containerName(purpose),
		Image: testImage,
		Command: []string{
			"sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done",
		},
		Labels: map[string]string{
			e2eLabel:    "true",
			e2eRunLabel: runID,
		},
	}
}

/** Registers a container the product created, so the harness cleans it up. */
func adopt(t *testing.T, name string, id string) {
	t.Helper()

	created[name] = id

	t.Cleanup(func() {
		delete(created, name)
		_ = exec.Command("docker", "rm", "-f", name).Run()
	})
}

/** Removes a volume this run created, after the containers using it are gone. */
func ownedVolume(t *testing.T, purpose string) string {
	t.Helper()

	name := containerName(purpose) + "-data"

	run(t, "volume", "create", "--label", e2eLabel+"=true", "--label", e2eRunLabel+"="+runID, name)

	t.Cleanup(func() {
		_ = exec.Command("docker", "volume", "rm", "-f", name).Run()
	})

	return name
}

func inspectJSON(t *testing.T, name string, format string) string {
	t.Helper()

	return run(t, "inspect", "--format", format, name)
}

func TestRealCreateBuildsTheContainerItWasAsked(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	volume := ownedVolume(t, "create")
	spec := ownedSpec("create")

	spec.Env = []docker.EnvVar{
		{Key: "LOG_LEVEL", Value: "debug"},
		{Key: "DB_PASSWORD", Value: managedSecret},
	}
	spec.Ports = []docker.PortSpec{{ContainerPort: 80, HostPort: 0, Protocol: "tcp"}}
	spec.Mounts = []docker.MountSpec{{Type: "volume", Source: volume, Target: "/data"}}
	spec.RestartPolicy = "unless-stopped"

	result, err := engine.Create(ctx, spec, "", "resource-1", "config-a")

	if err != nil {
		t.Fatalf("create: %v", err)
	}

	adopt(t, spec.Name, result.ContainerID)
	mustOwn(t, spec.Name)

	if result.State != "running" {
		t.Fatalf("state = %q, want running", result.State)
	}

	// The identity the server allocated, on the container Docker built.
	labels := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.container-id\"}}")

	if labels != "resource-1" {
		t.Errorf("container-id label = %q", labels)
	}

	config := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.desired-config-id\"}}")

	if config != "config-a" {
		t.Errorf("desired-config-id label = %q", config)
	}

	managed := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.managed\"}}")

	if managed != "true" {
		t.Errorf("managed label = %q", managed)
	}

	if policy := inspectJSON(t, spec.Name, "{{.HostConfig.RestartPolicy.Name}}"); policy != "unless-stopped" {
		t.Errorf("restart policy = %q", policy)
	}

	if mounts := inspectJSON(t, spec.Name, "{{range .Mounts}}{{.Name}}{{end}}"); mounts != volume {
		t.Errorf("mounted volume = %q, want %q", mounts, volume)
	}

	/*
	 * The environment reached the container, and does not come back out.
	 * Inspect is what the control server stores, and it is built field by
	 * field from what the agent chose to report.
	 */
	detail, err := engine.InspectContainer(ctx, result.ContainerID)

	if err != nil {
		t.Fatalf("inspect: %v", err)
	}

	encoded, err := json.Marshal(detail)

	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	if strings.Contains(string(encoded), managedSecret) {
		t.Fatal("the inspect projection carried an environment value")
	}
}

/*
A replacement is a new container and the same data.

The volume is written to before the replacement and read after it, because that
is the promise: an operator changing a port on a database does not lose the
database. The container is genuinely rebuilt — Docker gives it a new identifier
— and the volume is the thing that is deliberately not.
*/
func TestRealReplaceKeepsTheVolumeAndItsContents(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	volume := ownedVolume(t, "replace")
	spec := ownedSpec("replace")

	spec.Env = []docker.EnvVar{{Key: "DB_PASSWORD", Value: managedSecret}}
	spec.Mounts = []docker.MountSpec{{Type: "volume", Source: volume, Target: "/data"}}

	first, err := engine.Create(ctx, spec, "", "resource-2", "config-a")

	if err != nil {
		t.Fatalf("create: %v", err)
	}

	adopt(t, spec.Name, first.ContainerID)
	mustOwn(t, spec.Name)

	run(t, "exec", spec.Name, "sh", "-c", "echo the-data-must-survive > /data/state")

	// The change: a new port and a new secret. Same name, same volume.
	candidate := ownedSpec("replace")
	candidate.Env = []docker.EnvVar{{Key: "DB_PASSWORD", Value: "a-different-secret"}}
	candidate.Mounts = spec.Mounts
	candidate.Ports = []docker.PortSpec{{ContainerPort: 80, HostPort: 0, Protocol: "tcp"}}
	candidate.RestartPolicy = "unless-stopped"

	replaced, err := engine.Replace(ctx, first.ContainerID, candidate, "", "resource-2", "config-b")

	if err != nil {
		t.Fatalf("replace: %v", err)
	}

	adopt(t, spec.Name, replaced.ContainerID)
	mustOwn(t, spec.Name)

	if replaced.ContainerID == first.ContainerID {
		t.Fatal("the container was not actually replaced")
	}

	// Same Dockplane resource, new configuration, and it says so.
	if id := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.container-id\"}}"); id != "resource-2" {
		t.Errorf("container-id label = %q", id)
	}

	if config := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.desired-config-id\"}}"); config != "config-b" {
		t.Errorf("desired-config-id label = %q", config)
	}

	if policy := inspectJSON(t, spec.Name, "{{.HostConfig.RestartPolicy.Name}}"); policy != "unless-stopped" {
		t.Errorf("restart policy = %q", policy)
	}

	// The whole point.
	contents := run(t, "exec", spec.Name, "cat", "/data/state")

	if !strings.Contains(contents, "the-data-must-survive") {
		t.Fatalf("the volume lost its contents: %q", contents)
	}

	if !volumeExists(volume) {
		t.Fatal("the volume was removed with the container it was mounted in")
	}
}

/*
A replacement that cannot start leaves everything as it was.

The failure is arranged rather than simulated: the candidate names an image tag
that does not exist, so the replacement genuinely cannot be built. What matters
is what is true afterwards — the original container, under its own identifier,
still carrying the configuration that is actually running, with its data intact
and no leftover container beside it.
*/
func TestRealFailedReplaceRollsBackToTheOriginal(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	volume := ownedVolume(t, "rollback")
	spec := ownedSpec("rollback")

	spec.Mounts = []docker.MountSpec{{Type: "volume", Source: volume, Target: "/data"}}

	original, err := engine.Create(ctx, spec, "", "resource-3", "config-a")

	if err != nil {
		t.Fatalf("create: %v", err)
	}

	adopt(t, spec.Name, original.ContainerID)
	mustOwn(t, spec.Name)

	run(t, "exec", spec.Name, "sh", "-c", "echo survives-a-failed-change > /data/state")

	candidate := ownedSpec("rollback")
	candidate.Image = "busybox:this-tag-does-not-exist-anywhere"
	candidate.Mounts = spec.Mounts

	if _, err := engine.Replace(ctx, original.ContainerID, candidate, "", "resource-3", "config-b"); err == nil {
		t.Fatal("a replacement with an unavailable image was reported as success")
	}

	mustOwn(t, spec.Name)

	// The original, unchanged: same identifier, same configuration identity.
	if id := inspectJSON(t, spec.Name, "{{.Id}}"); !strings.HasPrefix(id, original.ContainerID) {
		t.Fatalf("the container under this name is %q, not the original", id)
	}

	if config := inspectJSON(t, spec.Name, "{{index .Config.Labels \"io.dockplane.desired-config-id\"}}"); config != "config-a" {
		t.Errorf("the original was restamped: desired-config-id = %q", config)
	}

	if state := inspectJSON(t, spec.Name, "{{.State.Status}}"); state != "running" {
		t.Errorf("the original is %q", state)
	}

	contents := run(t, "exec", spec.Name, "cat", "/data/state")

	if !strings.Contains(contents, "survives-a-failed-change") {
		t.Fatalf("the volume lost its contents: %q", contents)
	}

	// And nothing was left beside it.
	for _, leftover := range []string{spec.Name + ".dockplane-new", spec.Name + ".dockplane-old"} {
		if containerExists(leftover) {
			t.Errorf("%s was left behind", leftover)
		}
	}
}

/*
Removing a container keeps its volume.

Docker will remove anonymous volumes on request and Dockplane never asks. The
difference between a named volume and an anonymous one is not a difference an
operator should discover by losing data, so neither goes.
*/
func TestRealRemoveKeepsTheVolume(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	volume := ownedVolume(t, "remove")
	spec := ownedSpec("remove")

	spec.Mounts = []docker.MountSpec{{Type: "volume", Source: volume, Target: "/data"}}

	container, err := engine.Create(ctx, spec, "", "resource-4", "config-a")

	if err != nil {
		t.Fatalf("create: %v", err)
	}

	adopt(t, spec.Name, container.ContainerID)
	mustOwn(t, spec.Name)

	run(t, "exec", spec.Name, "sh", "-c", "echo outlives-the-container > /data/state")
	mustOwn(t, spec.Name)

	if _, err := engine.Remove(ctx, container.ContainerID, true); err != nil {
		t.Fatalf("remove: %v", err)
	}

	if containerExists(spec.Name) {
		t.Fatal("the container is still there")
	}

	if !volumeExists(volume) {
		t.Fatal("the volume was removed with the container")
	}

	// The data is still in it, which is what "the volume survived" has to mean.
	contents := run(t, "run", "--rm",
		"--label", e2eLabel+"=true",
		"--label", e2eRunLabel+"="+runID,
		"--volume", volume+":/data",
		testImage, "cat", "/data/state",
	)

	if !strings.Contains(contents, "outlives-the-container") {
		t.Fatalf("the volume kept nothing: %q", contents)
	}
}

func containerExists(name string) bool {
	return exec.Command("docker", "inspect", name).Run() == nil
}

func volumeExists(name string) bool {
	return exec.Command("docker", "volume", "inspect", name).Run() == nil
}
