//go:build docker_integration

package docker_test

import (
	"context"
	"errors"
	"net"
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

	result, err := engine.ApplyStack(ctx, plan)

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

	if _, err := engine.ApplyStack(ctx, plan); err == nil {
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

	if _, err := engine.ApplyStack(ctx, plan); err == nil {
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

/*
Moving a real stack from one revision to another.

The daemon is where this is decided. A stack-wide staging that works against a
model and not against Docker would be worth nothing: the alias a stopped
container keeps, the port it still holds and the name it still occupies are all
daemon behaviour, and the whole design of the transition is a response to them.
*/
func TestStackTransitionsBetweenRealRevisions(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	first := stackPlan(t, "stack-transition-"+runID, "transition")
	cleanUpStack(t, first)

	if _, err := engine.ApplyStack(ctx, first); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	for _, service := range first.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))
	}

	was := map[string]string{}

	for _, service := range first.Services {
		was[service.ServiceName] = inspect(t, service.ContainerName, "{{.Id}}")
	}

	// Something only a volume can prove: the data is the same data afterwards.
	writeIntoVolume(t, first, "the-data-must-survive")

	second := stackPlan(t, first.StackID, "transition")
	second.RevisionID = "revision-two-" + runID

	// Two services swapping the host port they publish, which is the case a
	// per-service replacement could not do at all.
	second.Services[0].Spec.Ports = []docker.PortSpec{{ContainerPort: 81, HostPort: freePort(t), Protocol: "tcp"}}
	second.Services[1].Spec.Ports = []docker.PortSpec{{ContainerPort: 82, HostPort: freePort(t), Protocol: "tcp"}}

	result, err := engine.ApplyStack(ctx, second)

	if err != nil {
		t.Fatalf("second apply: %v", err)
	}

	if result.Outcome != docker.OutcomeApplied {
		t.Fatalf("outcome = %q: %+v", result.Outcome, result.Services)
	}

	for _, service := range second.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))

		if now := inspect(t, service.ContainerName, "{{.Id}}"); now == was[service.ServiceName] {
			t.Errorf("%s was not recreated", service.ServiceName)
		}

		if revision := label(t, service.ContainerName, docker.LabelStackRevisionID); revision != second.RevisionID {
			t.Errorf("%s carries revision %q", service.ServiceName, revision)
		}

		if identity := label(t, service.ContainerName, docker.LabelContainerID); identity == "" {
			t.Errorf("%s lost its Dockplane identity", service.ServiceName)
		}
	}

	// Nothing of the old revision is left behind, staged or otherwise.
	if staged := run(t, "ps", "-a", "--filter", "name=dockplane-staged", "--format", "{{.Names}}"); staged != "" {
		t.Errorf("staged containers were left behind: %s", staged)
	}

	if data := readFromVolume(t, second); data != "the-data-must-survive" {
		t.Errorf("the volume now holds %q", data)
	}
}

/*
A revision that cannot start, on a real daemon.

The image exists, so everything gets past preflight and the stack is genuinely
taken down before the failure happens. What is being proved is that it comes
back: same containers, same names, same networks, same data.
*/
func TestStackPutsARealStackBackWhenTheTargetWillNotStart(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	first := stackPlan(t, "stack-rollback-"+runID, "rollback")
	cleanUpStack(t, first)

	if _, err := engine.ApplyStack(ctx, first); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	for _, service := range first.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))
	}

	was := map[string]string{}
	networks := map[string]string{}

	for _, service := range first.Services {
		was[service.ServiceName] = inspect(t, service.ContainerName, "{{.Id}}")
		networks[service.ServiceName] = inspect(t, service.ContainerName,
			"{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}")
	}

	writeIntoVolume(t, first, "still-here-after-a-failed-deploy")

	broken := stackPlan(t, first.StackID, "rollback")
	broken.RevisionID = "revision-broken-" + runID
	// A command the image has and that exits immediately: the container is
	// created and started, and is not running a moment later.
	broken.Services[0].Spec.Command = []string{"sh", "-c", "exit 1"}

	result, err := engine.ApplyStack(ctx, broken)

	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if result.Outcome != docker.OutcomeRolledBack {
		t.Fatalf("outcome = %q: %+v", result.Outcome, result.Services)
	}

	for _, service := range first.Services {
		now := inspect(t, service.ContainerName, "{{.Id}}")

		if now != was[service.ServiceName] {
			t.Errorf("%s is a different container now", service.ServiceName)
		}

		if state := inspect(t, service.ContainerName, "{{.State.Status}}"); state != "running" {
			t.Errorf("%s is %s", service.ServiceName, state)
		}

		if revision := label(t, service.ContainerName, docker.LabelStackRevisionID); revision != first.RevisionID {
			t.Errorf("%s carries revision %q", service.ServiceName, revision)
		}

		attached := inspect(t, service.ContainerName,
			"{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}")

		if attached != networks[service.ServiceName] {
			t.Errorf("%s is on %q, was on %q", service.ServiceName, attached, networks[service.ServiceName])
		}
	}

	if staged := run(t, "ps", "-a", "--filter", "name=dockplane-staged", "--format", "{{.Names}}"); staged != "" {
		t.Errorf("staged containers were left behind: %s", staged)
	}

	if data := readFromVolume(t, first); data != "still-here-after-a-failed-deploy" {
		t.Errorf("the volume now holds %q", data)
	}
}

/*
Services reach each other by service name while a revision is being replaced.

The reason old containers are disconnected rather than merely renamed. A stopped
container keeps its endpoint on the network, and Docker refuses a second
endpoint answering to the same alias — so without the disconnect the new
container of a service could not be attached at all.
*/
func TestStackServicesResolveEachOtherOnARealDaemon(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	first := stackPlan(t, "stack-alias-"+runID, "alias")
	cleanUpStack(t, first)

	if _, err := engine.ApplyStack(ctx, first); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	for _, service := range first.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))
	}

	// The alias is what a Compose file refers to a service by.
	resolve := func(from string, to string) string {
		output, err := exec.Command("docker", "exec", from, "nslookup", to).CombinedOutput()

		if err != nil || !strings.Contains(string(output), "Address") {
			return ""
		}

		return strings.TrimSpace(string(output))
	}

	if resolve(first.Services[0].ContainerName, "database") == "" {
		t.Fatal("web cannot resolve database by its service name")
	}

	second := stackPlan(t, first.StackID, "alias")
	second.RevisionID = "revision-alias-two-" + runID

	if _, err := engine.ApplyStack(ctx, second); err != nil {
		t.Fatalf("second apply: %v", err)
	}

	for _, service := range second.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))
	}

	if resolve(second.Services[0].ContainerName, "database") == "" {
		t.Error("web cannot resolve database after the revision was replaced")
	}
}

/*
A volume the running stack mounts, removed behind Dockplane's back.

Docker would create an empty one of the same name and everything would look
successful. The data would be gone, and the deployment record would say the
stack is fine.
*/
func TestStackRefusesWhenARealVolumeIsMissing(t *testing.T) {
	engine := requireDocker(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	first := stackPlan(t, "stack-volume-"+runID, "volume")
	cleanUpStack(t, first)

	if _, err := engine.ApplyStack(ctx, first); err != nil {
		t.Fatalf("first apply: %v", err)
	}

	for _, service := range first.Services {
		adopt(t, service.ContainerName, inspect(t, service.ContainerName, "{{.Id}}"))
	}

	/*
	 * Taken away outside Dockplane, which is the only way this state happens.
	 * The container mounting it has to go first — Docker will not remove a
	 * volume something is using — which is exactly the shape of the accident
	 * this refusal exists for.
	 */
	run(t, "rm", "-f", first.Services[1].ContainerName)
	delete(created, first.Services[1].ContainerName)
	run(t, "volume", "rm", "-f", first.Volumes[0].DockerName)

	second := stackPlan(t, first.StackID, "volume")
	second.RevisionID = "revision-volume-two-" + runID
	// The control server marks a volume the stack was already using, which is
	// what tells the agent this one is not new.
	second.Volumes[0].MustExist = true

	_, err := engine.ApplyStack(ctx, second)

	if err == nil {
		t.Fatal("a stack was deployed over a volume that had gone")
	}

	if !errors.Is(err, docker.ErrStackVolumeMissing) {
		t.Fatalf("err = %v", err)
	}

	if exists(t, "volume", first.Volumes[0].DockerName) {
		t.Error("an empty volume was created in its place")
	}

	if state := inspect(t, first.Services[0].ContainerName, "{{.State.Status}}"); state != "running" {
		t.Errorf("the rest of the stack is %s", state)
	}
}

/** Writes a known string into the stack's volume, through its own container. */
func writeIntoVolume(t *testing.T, plan *docker.StackPlan, content string) {
	t.Helper()

	run(t, "exec", plan.Services[1].ContainerName, "sh", "-c", "echo "+content+" > /data/marker")
}

func readFromVolume(t *testing.T, plan *docker.StackPlan) string {
	t.Helper()

	return run(t, "exec", plan.Services[1].ContainerName, "cat", "/data/marker")
}

/*
A host port nothing is listening on.

Asked of the operating system rather than guessed, so a machine that happens to
be running something on a chosen number does not fail this suite.
*/
func freePort(t *testing.T) uint16 {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")

	if err != nil {
		t.Fatalf("no free port: %v", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()

	return uint16(port)
}
