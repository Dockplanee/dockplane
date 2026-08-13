package docker_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"testing"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockersystem "github.com/docker/docker/api/types/system"
	"github.com/docker/docker/api/types/volume"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Applying a revision of a stack, without a Docker daemon.

A small model of a host rather than a mock of the calls: containers with names,
labels, network attachments and mounts, and the volumes and networks around
them. Everything asserted below is read back out of that model, so a test can
arrange the states that matter — a stack already running an older revision, a
volume that has gone missing, two containers claiming one service — and the code
has to reach the right conclusion about each.

The rules under scrutiny are the ones that cost data when they are wrong: what
is stopped before anything is created, what is put back when the new revision
does not come up, and what is never removed under any circumstances.
*/

type fakeContainer struct {
	id       string
	name     string
	labels   map[string]string
	running  bool
	networks map[string][]string
	mounts   []container.MountPoint
	/*
	 * When Docker last started this container.
	 *
	 * Modelled because the real engine behaves this way and the product depends
	 * on it: a restart keeps the container's identifier and everything else
	 * observable about it, and this is the only field that moves.
	 */
	startedAt string
}

type fakeHost struct {
	containers map[string]*fakeContainer
	networks   map[string]map[string]string
	volumes    map[string]map[string]string

	/** Every call that changed the host, in order. */
	ops []string

	next int

	/**
	 * Containers that refuse to start, keyed by revision and service.
	 *
	 * Not by name: the container being replaced and the one replacing it have
	 * the same name for most of an attempt, and a test needs to say which of
	 * the two is the one that will not come up.
	 */
	wontStart map[string]bool
	/** Containers that refuse to stop, keyed the same way. */
	wontStop map[string]bool
	/** How many starts this host has performed, which dates each one. */
	started int
	/** Set to make an image unavailable. */
	imageErr error

	/** Whether any removal asked Docker to take the volumes with it. */
	removedVolumes bool
}

func newHost() *fakeHost {
	return &fakeHost{
		containers: map[string]*fakeContainer{},
		networks:   map[string]map[string]string{},
		volumes:    map[string]map[string]string{},
		wontStart:  map[string]bool{},
		wontStop:   map[string]bool{},
	}
}

func (h *fakeHost) record(format string, arguments ...any) {
	h.ops = append(h.ops, fmt.Sprintf(format, arguments...))
}

/** Puts a container on the host, as something else created it. */
func (h *fakeHost) seed(
	name string,
	labels map[string]string,
	options ...func(*fakeContainer),
) *fakeContainer {
	h.next++

	found := &fakeContainer{
		id:       fmt.Sprintf("docker%04d", h.next),
		name:     name,
		labels:   labels,
		running:  true,
		networks: map[string][]string{},
	}

	for _, option := range options {
		option(found)
	}

	h.containers[found.id] = found

	return found
}

/** A container of a stack, as this agent would have created it. */
func (h *fakeHost) seedService(revision, service, resource, name string) *fakeContainer {
	return h.seed(name, map[string]string{
		docker.LabelManaged:         "true",
		docker.LabelStackID:         "stack-1",
		docker.LabelStackRevisionID: revision,
		docker.LabelStackService:    service,
		docker.LabelContainerID:     resource,
	}, func(found *fakeContainer) {
		found.networks = map[string][]string{"shop_default": {service}}
	})
}

func (h *fakeHost) byName(name string) *fakeContainer {
	for _, found := range h.containers {
		if found.name == name {
			return found
		}
	}

	return nil
}

func (h *fakeHost) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	listed := make([]container.Summary, 0, len(h.containers))

	for _, found := range h.containers {
		listed = append(listed, container.Summary{
			ID:     found.id,
			Names:  []string{"/" + found.name},
			Labels: found.labels,
		})
	}

	sort.Slice(listed, func(left, right int) bool { return listed[left].ID < listed[right].ID })

	return listed, nil
}

func (h *fakeHost) ContainerInspect(_ context.Context, id string) (container.InspectResponse, error) {
	found, present := h.containers[id]

	if !present {
		return container.InspectResponse{}, errors.New("no such container")
	}

	endpoints := map[string]*network.EndpointSettings{}

	for name, aliases := range found.networks {
		endpoints[name] = &network.EndpointSettings{Aliases: append([]string{}, aliases...)}
	}

	status := "exited"

	if found.running {
		status = "running"
	}

	return container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID:   found.id,
			Name: "/" + found.name,
			State: &container.State{
				Running:   found.running,
				Status:    status,
				StartedAt: found.startedAt,
			},
		},
		Mounts:          found.mounts,
		NetworkSettings: &container.NetworkSettings{Networks: endpoints},
	}, nil
}

func (h *fakeHost) ContainerCreate(
	_ context.Context,
	config *container.Config,
	_ *container.HostConfig,
	_ *network.NetworkingConfig,
	_ *ocispec.Platform,
	name string,
) (container.CreateResponse, error) {
	if h.byName(name) != nil {
		return container.CreateResponse{}, errors.New("Conflict. The container name is already in use")
	}

	h.next++
	id := fmt.Sprintf("docker%04d", h.next)
	labels := map[string]string{}

	for key, value := range config.Labels {
		labels[key] = value
	}

	h.containers[id] = &fakeContainer{
		id:       id,
		name:     name,
		labels:   labels,
		networks: map[string][]string{},
	}

	h.record("create:%s", name)

	return container.CreateResponse{ID: id}, nil
}

func (h *fakeHost) ContainerRemove(_ context.Context, id string, options container.RemoveOptions) error {
	if options.RemoveVolumes {
		h.removedVolumes = true
	}

	if found, present := h.containers[id]; present {
		h.record("remove:%s", found.name)
		delete(h.containers, id)
	}

	return nil
}

func (h *fakeHost) ContainerRename(_ context.Context, id string, name string) error {
	if found, present := h.containers[id]; present {
		h.record("rename:%s>%s", found.name, name)
		found.name = name
	}

	return nil
}

func (h *fakeHost) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	found, present := h.containers[id]

	if !present {
		return errors.New("no such container")
	}

	h.record("start:%s", found.name)

	if h.wontStart[revisionService(found)] {
		return errors.New("the container would not start")
	}

	found.running = true
	h.started++
	// Monotonic, as Docker's own is: what makes a container that was just
	// started distinguishable from the same container left alone.
	found.startedAt = fmt.Sprintf("2026-01-01T00:00:%02dZ", h.started)

	return nil
}

/** How a test names one particular container of one particular revision. */
func revisionService(found *fakeContainer) string {
	return found.labels[docker.LabelStackRevisionID] + "/" + found.labels[docker.LabelStackService]
}

func (h *fakeHost) ContainerStop(_ context.Context, id string, _ container.StopOptions) error {
	if found, present := h.containers[id]; present {
		h.record("stop:%s", found.name)

		if h.wontStop[revisionService(found)] {
			return errors.New("the container would not stop")
		}

		found.running = false
	}

	return nil
}

func (h *fakeHost) NetworkConnect(
	_ context.Context,
	networkID string,
	containerID string,
	config *network.EndpointSettings,
) error {
	found, present := h.containers[containerID]

	if !present {
		return errors.New("no such container")
	}

	var aliases []string

	if config != nil {
		aliases = append(aliases, config.Aliases...)
	}

	/*
	 * Docker's own refusal, which is the reason staging disconnects the old
	 * containers: two endpoints on one network cannot answer to one alias.
	 */
	for id, other := range h.containers {
		if id == containerID {
			continue
		}

		for _, held := range other.networks[networkID] {
			for _, wanted := range aliases {
				if held == wanted {
					return fmt.Errorf("network %s already has an endpoint named %s", networkID, held)
				}
			}
		}
	}

	found.networks[networkID] = aliases
	h.record("connect:%s:%s", found.name, networkID)

	return nil
}

func (h *fakeHost) NetworkDisconnect(_ context.Context, networkID, containerID string, _ bool) error {
	if found, present := h.containers[containerID]; present {
		delete(found.networks, networkID)
		h.record("disconnect:%s:%s", found.name, networkID)
	}

	return nil
}

func (h *fakeHost) NetworkList(context.Context, network.ListOptions) ([]network.Summary, error) {
	listed := make([]network.Summary, 0, len(h.networks))

	for name, labels := range h.networks {
		listed = append(listed, network.Summary{Name: name, Labels: labels})
	}

	return listed, nil
}

func (h *fakeHost) NetworkCreate(
	_ context.Context,
	name string,
	options network.CreateOptions,
) (network.CreateResponse, error) {
	h.networks[name] = options.Labels
	h.record("network:%s", name)

	return network.CreateResponse{ID: "net-" + name}, nil
}

func (h *fakeHost) NetworkRemove(_ context.Context, name string) error {
	delete(h.networks, name)
	h.record("network-remove:%s", name)

	return nil
}

func (h *fakeHost) VolumeList(context.Context, volume.ListOptions) (volume.ListResponse, error) {
	listed := volume.ListResponse{}

	for name, labels := range h.volumes {
		listed.Volumes = append(listed.Volumes, &volume.Volume{Name: name, Labels: labels})
	}

	return listed, nil
}

func (h *fakeHost) VolumeCreate(
	_ context.Context,
	options volume.CreateOptions,
) (volume.Volume, error) {
	h.volumes[options.Name] = options.Labels
	h.record("volume:%s", options.Name)

	return volume.Volume{Name: options.Name}, nil
}

func (h *fakeHost) ImageInspect(
	_ context.Context,
	_ string,
	_ ...dockerclient.ImageInspectOption,
) (image.InspectResponse, error) {
	if h.imageErr != nil {
		return image.InspectResponse{}, h.imageErr
	}

	return image.InspectResponse{ID: "sha256:present"}, nil
}

func (h *fakeHost) ImagePull(
	_ context.Context,
	_ string,
	_ image.PullOptions,
) (io.ReadCloser, error) {
	if h.imageErr != nil {
		return nil, h.imageErr
	}

	return io.NopCloser(strings.NewReader("")), nil
}

func (h *fakeHost) ContainerLogs(
	context.Context,
	string,
	container.LogsOptions,
) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func (h *fakeHost) ContainerRestart(context.Context, string, container.StopOptions) error {
	return nil
}

func (h *fakeHost) Info(context.Context) (dockersystem.Info, error) {
	return dockersystem.Info{}, nil
}

func (h *fakeHost) ServerVersion(context.Context) (dockertypes.Version, error) {
	return dockertypes.Version{}, nil
}

func (h *fakeHost) Close() error { return nil }

/** A stack of two services, one depending on the other. */
func plan(revision string) *docker.StackPlan {
	return &docker.StackPlan{
		PlanVersion: docker.StackPlanVersion,
		StackID:     "stack-1",
		RevisionID:  revision,
		ProjectName: "shop",
		Networks:    []docker.StackNetwork{{Name: "default", DockerName: "shop_default"}},
		Volumes:     []docker.StackVolume{{Name: "data", DockerName: "shop_data"}},
		Services: []docker.StackService{
			{
				ServiceName:   "web",
				ContainerID:   "resource-web",
				ContainerName: "shop-web-1",
				DependsOn:     []string{"database"},
				Spec: docker.ContainerSpec{
					Name:     "shop-web-1",
					Image:    "nginx:1.27",
					Networks: []string{"shop_default"},
				},
			},
			{
				ServiceName:   "database",
				ContainerID:   "resource-db",
				ContainerName: "shop-database-1",
				Spec: docker.ContainerSpec{
					Name:     "shop-database-1",
					Image:    "postgres:17",
					Networks: []string{"shop_default"},
					Mounts: []docker.MountSpec{
						{Type: "volume", Source: "shop_data", Target: "/var/lib/postgresql/data"},
					},
				},
			},
		},
	}
}

/** A host already running revision A of that stack. */
func runningStack() *fakeHost {
	host := newHost()

	host.networks["shop_default"] = map[string]string{
		docker.LabelManaged:      "true",
		docker.LabelStackID:      "stack-1",
		docker.LabelStackNetwork: "default",
	}

	host.volumes["shop_data"] = map[string]string{
		docker.LabelManaged:     "true",
		docker.LabelStackID:     "stack-1",
		docker.LabelStackVolume: "data",
	}

	database := host.seedService("revision-a", "database", "resource-db", "shop-database-1")
	database.mounts = []container.MountPoint{
		{Type: "volume", Name: "shop_data", Destination: "/var/lib/postgresql/data"},
	}

	host.seedService("revision-a", "web", "resource-web", "shop-web-1")

	return host
}

func apply(t *testing.T, host *fakeHost, target *docker.StackPlan) (*docker.StackApplyResult, error) {
	t.Helper()

	return docker.NewEngine(host).ApplyStack(context.Background(), target)
}

func TestStackStartsDependenciesFirst(t *testing.T) {
	result, err := apply(t, newHost(), plan("revision-a"))

	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if !result.Complete || result.Outcome != docker.OutcomeApplied {
		t.Fatalf("outcome = %q: %+v", result.Outcome, result.Services)
	}

	if result.Services[0].ServiceName != "database" || result.Services[1].ServiceName != "web" {
		t.Fatalf("order = %s, %s", result.Services[0].ServiceName, result.Services[1].ServiceName)
	}
}

func TestStackRefusesServicesThatDependOnEachOther(t *testing.T) {
	broken := plan("revision-a")
	broken.Services[1].DependsOn = []string{"web"}

	if _, err := apply(t, newHost(), broken); err == nil {
		t.Fatal("a dependency cycle was applied")
	}
}

func TestStackRefusesAPlanThisBuildDoesNotSpeak(t *testing.T) {
	for _, version := range []int{docker.StackPlanVersion - 1, docker.StackPlanVersion + 1} {
		other := plan("revision-a")
		other.PlanVersion = version

		if _, err := apply(t, newHost(), other); !errors.Is(err, docker.ErrStackPlanUnsupported) {
			t.Fatalf("version %d: err = %v", version, err)
		}
	}
}

/*
The identity a stack's containers carry.

Set here from what the server resolved, never from the specification a caller
sent: this is how discovery recognises which stack, which revision and which
service a container is afterwards.
*/
func TestStackStampsItsOwnIdentity(t *testing.T) {
	host := newHost()

	if _, err := apply(t, host, plan("revision-a")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	labels := host.byName("shop-web-1").labels

	for key, want := range map[string]string{
		docker.LabelManaged:         "true",
		docker.LabelStackID:         "stack-1",
		docker.LabelStackRevisionID: "revision-a",
		docker.LabelStackService:    "web",
		docker.LabelContainerID:     "resource-web",
	} {
		if labels[key] != want {
			t.Errorf("%s = %q, want %q", key, labels[key], want)
		}
	}
}

/*
Services reach each other by the name their author used.

A Compose file says `database`, not `shop-database-1`. Without the alias a stack
would resolve only Dockplane's own container names, and configuration written
against Compose's conventions would fail to connect.
*/
func TestStackServicesAreReachableByServiceName(t *testing.T) {
	host := newHost()

	if _, err := apply(t, host, plan("revision-a")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	aliases := host.byName("shop-database-1").networks["shop_default"]

	if len(aliases) != 1 || aliases[0] != "database" {
		t.Errorf("aliases = %v", aliases)
	}
}

func TestStackLabelsTheResourcesItCreates(t *testing.T) {
	host := newHost()

	if _, err := apply(t, host, plan("revision-a")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if host.networks["shop_default"][docker.LabelStackNetwork] != "default" {
		t.Errorf("network labels = %v", host.networks["shop_default"])
	}

	if host.volumes["shop_data"][docker.LabelStackVolume] != "data" {
		t.Errorf("volume labels = %v", host.volumes["shop_data"])
	}
}

/** Nothing on this host is adopted because a name matched. */
func TestStackRefusesResourcesItDoesNotOwn(t *testing.T) {
	t.Run("a container", func(t *testing.T) {
		host := newHost()
		host.seed("shop-web-1", map[string]string{})

		if _, err := apply(t, host, plan("revision-a")); !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}

		if len(host.ops) > 0 {
			t.Errorf("the host was changed: %v", host.ops)
		}
	})

	t.Run("a volume holding somebody's data", func(t *testing.T) {
		host := newHost()
		host.volumes["shop_data"] = map[string]string{}

		if _, err := apply(t, host, plan("revision-a")); !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("a network", func(t *testing.T) {
		host := newHost()
		host.networks["shop_default"] = map[string]string{}

		if _, err := apply(t, host, plan("revision-a")); !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestStackReusesWhatItAlreadyOwns(t *testing.T) {
	host := runningStack()

	if _, err := apply(t, host, plan("revision-b")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	for _, operation := range host.ops {
		if strings.HasPrefix(operation, "volume:") || strings.HasPrefix(operation, "network:") {
			t.Errorf("an owned resource was created again: %s", operation)
		}
	}
}

/*
An image that cannot be pulled stops everything before anything is touched.

The commonest way a deployment fails, and on a redeployment the one that would
otherwise take a running stack down for nothing.
*/
func TestStackPullsEveryImageBeforeTouchingTheStack(t *testing.T) {
	host := runningStack()
	host.imageErr = errors.New("no such image")

	if _, err := apply(t, host, plan("revision-b")); err == nil {
		t.Fatal("a stack with an unavailable image was applied")
	}

	if len(host.ops) > 0 {
		t.Errorf("the host was changed: %v", host.ops)
	}

	if !host.byName("shop-web-1").running {
		t.Error("the running stack was stopped")
	}
}

/*
Moving a running stack to another revision.

Everything is stopped, renamed out of the way and disconnected before the first
new container is created — otherwise a service that swaps a port, a name or an
alias with another would collide with the very containers it is replacing. The
old containers go only once the new ones are up.
*/
func TestStackTransitionStagesTheRunningRevisionAside(t *testing.T) {
	host := runningStack()
	before := host.byName("shop-web-1").id

	result, err := apply(t, host, plan("revision-b"))

	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if result.Outcome != docker.OutcomeApplied {
		t.Fatalf("outcome = %q", result.Outcome)
	}

	firstCreate := indexOf(host.ops, "create:")
	lastStage := lastIndexOf(host.ops, "disconnect:")

	if firstCreate < 0 || lastStage < 0 || lastStage > firstCreate {
		t.Fatalf("staging and creation interleaved: %v", host.ops)
	}

	web := host.byName("shop-web-1")

	if web.id == before {
		t.Error("the container was not recreated")
	}

	if web.labels[docker.LabelContainerID] != "resource-web" {
		t.Errorf("container identity = %q", web.labels[docker.LabelContainerID])
	}

	if web.labels[docker.LabelStackRevisionID] != "revision-b" {
		t.Errorf("revision = %q", web.labels[docker.LabelStackRevisionID])
	}

	if len(host.containers) != 2 {
		t.Errorf("containers = %d", len(host.containers))
	}

	if host.removedVolumes {
		t.Error("a removal asked Docker to take the volumes")
	}

	if _, present := host.volumes["shop_data"]; !present {
		t.Error("the volume is gone")
	}
}

/*
Every service is recreated, even one whose configuration did not change.

That is what makes the revision a container belongs to readable off the
container itself, rather than something inferred from a configuration nobody
can see.
*/
func TestStackTransitionRecreatesEveryService(t *testing.T) {
	host := runningStack()
	before := map[string]string{
		"shop-web-1":      host.byName("shop-web-1").id,
		"shop-database-1": host.byName("shop-database-1").id,
	}

	if _, err := apply(t, host, plan("revision-b")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	for name, was := range before {
		found := host.byName(name)

		if found.id == was {
			t.Errorf("%s was not recreated", name)
		}

		if found.labels[docker.LabelStackRevisionID] != "revision-b" {
			t.Errorf("%s carries revision %q", name, found.labels[docker.LabelStackRevisionID])
		}
	}
}

/*
A target that does not come up puts the host back.

The most important path in this file. What was running is running again, under
its own name, on the networks it was on, and the containers this attempt built
are gone. Nothing that could hold data is removed.
*/
func TestStackRestoresTheRunningRevisionWhenTheTargetFails(t *testing.T) {
	host := runningStack()
	host.wontStart["revision-b/web"] = true

	result, err := apply(t, host, plan("revision-b"))

	if err != nil {
		t.Fatalf("a failed apply is a result, not an error: %v", err)
	}

	if result.Outcome != docker.OutcomeRolledBack {
		t.Fatalf("outcome = %q", result.Outcome)
	}

	if result.FailedService != "web" {
		t.Errorf("failed service = %q", result.FailedService)
	}

	for _, name := range []string{"shop-web-1", "shop-database-1"} {
		found := host.byName(name)

		if found == nil {
			t.Fatalf("%s is gone", name)
		}

		if !found.running {
			t.Errorf("%s is not running again", name)
		}

		if found.labels[docker.LabelStackRevisionID] != "revision-a" {
			t.Errorf("%s carries revision %q", name, found.labels[docker.LabelStackRevisionID])
		}

		if aliases := found.networks["shop_default"]; len(aliases) == 0 {
			t.Errorf("%s was not put back on its network", name)
		}
	}

	if len(host.containers) != 2 {
		t.Errorf("containers left behind: %d", len(host.containers))
	}

	if host.removedVolumes || len(host.volumes) != 1 {
		t.Error("a volume was touched while putting the host back")
	}
}

/*
A container that was stopped before the attempt stays stopped.

Restoring means restoring. Starting something an operator had deliberately
stopped would be an improvement nobody asked for, reported as if the host were
as it was found.
*/
func TestStackRestoresStoppedContainersAsStopped(t *testing.T) {
	host := runningStack()
	host.byName("shop-web-1").running = false
	host.wontStart["revision-b/database"] = true

	if _, err := apply(t, host, plan("revision-b")); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if host.byName("shop-web-1").running {
		t.Error("a container that was stopped was started")
	}
}

/*
When putting the host back does not fully work, it says so.

An operator told "rolled back" stops looking. The difference between that and
"somebody has to look at this" is the whole value of the answer.
*/
func TestStackReportsAnIncompleteRestore(t *testing.T) {
	host := runningStack()

	// The target does not come up, and neither does the container it replaced.
	host.wontStart["revision-b/web"] = true
	host.wontStart["revision-a/web"] = true

	result, err := apply(t, host, plan("revision-b"))

	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if result.Outcome != docker.OutcomeRollbackIncomplete {
		t.Fatalf("outcome = %q", result.Outcome)
	}
}

/*
A volume the running stack mounts has gone.

Docker would happily create an empty one of the same name, the stack would come
up, and the data would be gone with nothing saying so.
*/
func TestStackRefusesWhenAVolumeItUsesIsMissing(t *testing.T) {
	host := runningStack()
	delete(host.volumes, "shop_data")

	if _, err := apply(t, host, plan("revision-b")); !errors.Is(err, docker.ErrStackVolumeMissing) {
		t.Fatalf("err = %v", err)
	}

	if len(host.ops) > 0 {
		t.Errorf("the host was changed: %v", host.ops)
	}
}

/*
A host that does not say clearly what the stack is.

Two containers claiming one service, or a container claiming a service under an
identity the control server did not give it. Applying over that would mean
choosing which container is the real one.
*/
func TestStackRefusesAnAmbiguousHost(t *testing.T) {
	t.Run("two containers are the same service", func(t *testing.T) {
		host := runningStack()
		host.seedService("revision-a", "web", "resource-web", "shop-web-1.old")

		if _, err := apply(t, host, plan("revision-b")); !errors.Is(err, docker.ErrStackStateAmbiguous) {
			t.Fatalf("err = %v", err)
		}

		if len(host.ops) > 0 {
			t.Errorf("the host was changed: %v", host.ops)
		}
	})

	t.Run("a service is held by another identity", func(t *testing.T) {
		host := runningStack()
		host.byName("shop-web-1").labels[docker.LabelContainerID] = "somebody-elses-resource"

		if _, err := apply(t, host, plan("revision-b")); !errors.Is(err, docker.ErrStackStateAmbiguous) {
			t.Fatalf("err = %v", err)
		}
	})
}

/*
A service the target no longer has.

Its container is a way back until the target is up, so it is moved aside rather
than removed — and removed only once the new revision is running. Its volume
stays either way.
*/
func TestStackRemovesAServiceOnlyAfterTheTargetIsUp(t *testing.T) {
	host := runningStack()

	target := plan("revision-b")
	target.Services = target.Services[:1] // web only: database is being removed
	target.Services[0].DependsOn = nil

	if _, err := apply(t, host, target); err != nil {
		t.Fatalf("apply: %v", err)
	}

	if host.byName("shop-database-1") != nil {
		t.Error("the removed service's container is still there")
	}

	if _, present := host.volumes["shop_data"]; !present {
		t.Error("the removed service's volume was deleted")
	}

	if lastIndexOf(host.ops, "rename:shop-database-1") > indexOf(host.ops, "create:") {
		t.Errorf("the old container was moved after the target was built: %v", host.ops)
	}
}

func TestStackKeepsARemovedServiceWhenTheTargetFails(t *testing.T) {
	host := runningStack()
	host.wontStart["revision-b/web"] = true

	target := plan("revision-b")
	target.Services = target.Services[:1]
	target.Services[0].DependsOn = nil

	if _, err := apply(t, host, target); err != nil {
		t.Fatalf("apply: %v", err)
	}

	found := host.byName("shop-database-1")

	if found == nil || !found.running {
		t.Error("the service being removed was not put back")
	}
}

func TestStackRefusesASpecificationThatReachesForTheHost(t *testing.T) {
	dangerous := plan("revision-a")
	dangerous.Services[0].Spec.Mounts = []docker.MountSpec{
		{Type: "bind", Source: "/var/run/docker.sock", Target: "/sock"},
	}

	if _, err := apply(t, newHost(), dangerous); err == nil {
		t.Fatal("a stack mounted the Docker socket")
	}
}

func TestStackRefusesACallerSuppliedIdentityLabel(t *testing.T) {
	claimed := plan("revision-a")
	claimed.Services[0].Spec.Labels = map[string]string{docker.LabelStackID: "somebody-elses"}

	if _, err := apply(t, newHost(), claimed); err == nil {
		t.Fatal("a caller set a stack identity label")
	}
}

func TestStackRefusesAPlanThatNamesTwoServicesTheSame(t *testing.T) {
	duplicated := plan("revision-a")
	duplicated.Services[1].ContainerName = duplicated.Services[0].ContainerName

	if _, err := apply(t, newHost(), duplicated); err == nil {
		t.Fatal("two services would have had one name")
	}
}

func TestStackRefusesADependencyItDoesNotHave(t *testing.T) {
	missing := plan("revision-a")
	missing.Services[0].DependsOn = []string{"cache"}

	if _, err := apply(t, newHost(), missing); err == nil {
		t.Fatal("a service depended on something that is not in the plan")
	}
}

/*
Two services swapping what they publish, and their aliases with them.

The case stack-wide staging exists for. Applied one service at a time, the new
`web` would ask for something the old one still holds — a port, a name, an alias
on the network — and Docker would refuse it. Everything is moved aside first, so
nothing is held by the revision being replaced.
*/
func TestStackAppliesARevisionThatSwapsWhatServicesHold(t *testing.T) {
	host := runningStack()

	target := plan("revision-b")
	target.Services[0].Spec.Ports = []docker.PortSpec{{ContainerPort: 80, HostPort: 8081, Protocol: "tcp"}}
	target.Services[1].Spec.Ports = []docker.PortSpec{{ContainerPort: 5432, HostPort: 8080, Protocol: "tcp"}}

	result, err := apply(t, host, target)

	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if result.Outcome != docker.OutcomeApplied {
		t.Fatalf("outcome = %q", result.Outcome)
	}
}

func indexOf(operations []string, prefix string) int {
	for index, operation := range operations {
		if strings.HasPrefix(operation, prefix) {
			return index
		}
	}

	return -1
}

func lastIndexOf(operations []string, prefix string) int {
	found := -1

	for index, operation := range operations {
		if strings.HasPrefix(operation, prefix) {
			found = index
		}
	}

	return found
}
