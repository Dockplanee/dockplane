package docker_test

import (
	"context"
	"errors"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Deploying a stack, without a Docker daemon.

Two things are under test. The order — that a plan which cannot work produces
nothing at all, rather than a network and half a stack. And ownership — that a
container, volume or network whose name this stack wants but which belongs to
something else stops the deployment instead of being taken over.

The second is the one worth being strict about. A volume of the right name that
Dockplane did not create holds somebody's data.
*/

// fakeStack is the lifecycle fake plus the networks and volumes a stack needs.
type fakeStack struct {
	*fakeManager

	networks []network.Summary
	volumes  []*volume.Volume

	createdNetworks []string
	createdVolumes  []string
	removedNetworks []string

	networkCreateErr error
	volumeCreateErr  error
}

func newStack() *fakeStack {
	return &fakeStack{fakeManager: newManager(running())}
}

func (f *fakeStack) NetworkList(context.Context, network.ListOptions) ([]network.Summary, error) {
	return f.networks, nil
}

func (f *fakeStack) NetworkCreate(
	_ context.Context,
	name string,
	options network.CreateOptions,
) (network.CreateResponse, error) {
	if f.networkCreateErr != nil {
		return network.CreateResponse{}, f.networkCreateErr
	}

	f.createdNetworks = append(f.createdNetworks, name)
	f.networks = append(f.networks, network.Summary{Name: name, Labels: options.Labels})

	return network.CreateResponse{ID: "net-" + name}, nil
}

func (f *fakeStack) NetworkRemove(_ context.Context, name string) error {
	f.removedNetworks = append(f.removedNetworks, name)

	return nil
}

func (f *fakeStack) VolumeList(context.Context, volume.ListOptions) (volume.ListResponse, error) {
	return volume.ListResponse{Volumes: f.volumes}, nil
}

func (f *fakeStack) VolumeCreate(
	_ context.Context,
	options volume.CreateOptions,
) (volume.Volume, error) {
	if f.volumeCreateErr != nil {
		return volume.Volume{}, f.volumeCreateErr
	}

	f.createdVolumes = append(f.createdVolumes, options.Name)
	f.volumes = append(f.volumes, &volume.Volume{Name: options.Name, Labels: options.Labels})

	return volume.Volume{Name: options.Name}, nil
}

func plan() *docker.StackPlan {
	return &docker.StackPlan{
		PlanVersion: docker.StackPlanVersion,
		StackID:     "stack-1",
		RevisionID:  "revision-1",
		ProjectName: "shop",
		Networks:    []docker.StackNetwork{{Name: "default", DockerName: "shop_default"}},
		Volumes:     []docker.StackVolume{{Name: "data", DockerName: "shop_data"}},
		Services: []docker.StackService{
			{
				ServiceName:   "web",
				ContainerID:   "resource-web",
				ContainerName: "shop-web-1",
				DependsOn:     []string{"database"},
				Spec:          docker.ContainerSpec{Name: "shop-web-1", Image: "nginx:1.27"},
			},
			{
				ServiceName:   "database",
				ContainerID:   "resource-db",
				ContainerName: "shop-database-1",
				Spec:          docker.ContainerSpec{Name: "shop-database-1", Image: "postgres:17"},
			},
		},
	}
}

func TestStackStartsDependenciesFirst(t *testing.T) {
	client := newStack()

	result, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	if !result.Complete {
		t.Fatalf("incomplete: %+v", result.Services)
	}

	if result.Services[0].ServiceName != "database" || result.Services[1].ServiceName != "web" {
		t.Fatalf("order = %s, %s", result.Services[0].ServiceName, result.Services[1].ServiceName)
	}
}

func TestStackRefusesServicesThatDependOnEachOther(t *testing.T) {
	broken := plan()
	broken.Services[1].DependsOn = []string{"web"}

	if _, err := docker.NewEngine(newStack()).DeployStack(context.Background(), broken); err == nil {
		t.Fatal("a dependency cycle was deployed")
	}
}

func TestStackRefusesAPlanFromANewerServer(t *testing.T) {
	newer := plan()
	newer.PlanVersion = docker.StackPlanVersion + 1

	_, err := docker.NewEngine(newStack()).DeployStack(context.Background(), newer)

	if !errors.Is(err, docker.ErrStackPlanUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

/*
The identity a stack's containers carry.

Set here from what the server resolved, never from the specification a caller
sent: this is how discovery recognises which stack, which revision and which
service a container is afterwards.
*/
func TestStackStampsItsOwnIdentity(t *testing.T) {
	client := newStack()

	if _, err := docker.NewEngine(client).DeployStack(context.Background(), plan()); err != nil {
		t.Fatalf("deploy: %v", err)
	}

	labels := client.created["shop-web-1"]

	for key, want := range map[string]string{
		docker.LabelManaged:         "true",
		docker.LabelStackID:         "stack-1",
		docker.LabelStackRevisionID: "revision-1",
		docker.LabelStackService:    "web",
		docker.LabelContainerID:     "resource-web",
	} {
		if labels[key] != want {
			t.Errorf("%s = %q, want %q", key, labels[key], want)
		}
	}
}

func TestStackLabelsTheResourcesItCreates(t *testing.T) {
	client := newStack()

	if _, err := docker.NewEngine(client).DeployStack(context.Background(), plan()); err != nil {
		t.Fatalf("deploy: %v", err)
	}

	if len(client.createdNetworks) != 1 || client.createdNetworks[0] != "shop_default" {
		t.Errorf("networks = %v", client.createdNetworks)
	}

	if len(client.createdVolumes) != 1 || client.createdVolumes[0] != "shop_data" {
		t.Errorf("volumes = %v", client.createdVolumes)
	}

	for _, found := range client.networks {
		if found.Name == "shop_default" && found.Labels[docker.LabelStackNetwork] != "default" {
			t.Errorf("network labels = %v", found.Labels)
		}
	}

	for _, found := range client.volumes {
		if found.Name == "shop_data" && found.Labels[docker.LabelStackVolume] != "data" {
			t.Errorf("volume labels = %v", found.Labels)
		}
	}
}

/*
Nothing on this host is adopted because a name matched.
*/
func TestStackRefusesResourcesItDoesNotOwn(t *testing.T) {
	t.Run("a container", func(t *testing.T) {
		client := newStack()
		client.summaries = []container.Summary{{Names: []string{"/shop-web-1"}, Labels: map[string]string{}}}

		_, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

		if !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}

		if len(client.names) > 0 {
			t.Error("containers were created despite the conflict")
		}
	})

	t.Run("a volume holding somebody's data", func(t *testing.T) {
		client := newStack()
		client.volumes = []*volume.Volume{{Name: "shop_data", Labels: map[string]string{}}}

		_, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

		if !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}

		if len(client.createdNetworks) > 0 || len(client.names) > 0 {
			t.Error("the deployment got as far as creating something")
		}
	})

	t.Run("a network", func(t *testing.T) {
		client := newStack()
		client.networks = []network.Summary{{Name: "shop_default", Labels: map[string]string{}}}

		_, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

		if !errors.Is(err, docker.ErrStackResourceConflict) {
			t.Fatalf("err = %v", err)
		}
	})
}

/** A resource this stack made earlier is its own, and is reused. */
func TestStackReusesWhatItAlreadyOwns(t *testing.T) {
	client := newStack()

	client.volumes = []*volume.Volume{{
		Name: "shop_data",
		Labels: map[string]string{
			docker.LabelManaged:     "true",
			docker.LabelStackID:     "stack-1",
			docker.LabelStackVolume: "data",
		},
	}}

	if _, err := docker.NewEngine(client).DeployStack(context.Background(), plan()); err != nil {
		t.Fatalf("deploy: %v", err)
	}

	if len(client.createdVolumes) != 0 {
		t.Errorf("an owned volume was created again: %v", client.createdVolumes)
	}
}

/*
An image that cannot be pulled stops everything before anything exists.

The most common way a deployment fails, and the one where creating a network
first would leave litter behind for no reason.
*/
func TestStackPullsEveryImageBeforeCreatingAnything(t *testing.T) {
	client := newStack()
	client.inspectImageErr = errors.New("no such image")
	client.pullErr = errors.New("no such image")

	_, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

	if err == nil {
		t.Fatal("a stack with an unavailable image was deployed")
	}

	if len(client.createdNetworks) > 0 || len(client.createdVolumes) > 0 || len(client.names) > 0 {
		t.Errorf(
			"the host was changed: networks=%v volumes=%v containers=%v",
			client.createdNetworks,
			client.createdVolumes,
			client.names,
		)
	}
}

/*
A service that fails after another has started.

Nothing is torn down. The one that started may already have written to a volume,
and the result says what exists so that a person can decide.
*/
func TestStackLeavesWhatItStartedWhenAServiceFails(t *testing.T) {
	client := newStack()
	client.startErr = errors.New("the container would not start")

	result, err := docker.NewEngine(client).DeployStack(context.Background(), plan())

	if err != nil {
		t.Fatalf("a partial deployment is a result, not an error: %v", err)
	}

	if result.Complete {
		t.Fatal("reported complete")
	}

	if result.Services[0].ErrorCode == "" {
		t.Fatalf("no service was blamed: %+v", result.Services)
	}

	// The volume it had already made is still there.
	if len(client.createdVolumes) != 1 {
		t.Errorf("volumes = %v", client.createdVolumes)
	}
}

func TestStackRefusesASpecificationThatReachesForTheHost(t *testing.T) {
	dangerous := plan()
	dangerous.Services[0].Spec.Mounts = []docker.MountSpec{
		{Type: "bind", Source: "/var/run/docker.sock", Target: "/sock"},
	}

	if _, err := docker.NewEngine(newStack()).DeployStack(context.Background(), dangerous); err == nil {
		t.Fatal("a stack mounted the Docker socket")
	}
}

func TestStackRefusesACallerSuppliedIdentityLabel(t *testing.T) {
	claimed := plan()
	claimed.Services[0].Spec.Labels = map[string]string{docker.LabelStackID: "somebody-elses"}

	if _, err := docker.NewEngine(newStack()).DeployStack(context.Background(), claimed); err == nil {
		t.Fatal("a caller set a stack identity label")
	}
}

func TestStackRefusesAPlanThatNamesTwoServicesTheSame(t *testing.T) {
	duplicated := plan()
	duplicated.Services[1].ContainerName = duplicated.Services[0].ContainerName

	if _, err := docker.NewEngine(newStack()).DeployStack(context.Background(), duplicated); err == nil {
		t.Fatal("two services would have had one name")
	}
}

func TestStackRefusesADependencyItDoesNotHave(t *testing.T) {
	missing := plan()
	missing.Services[0].DependsOn = []string{"cache"}

	if _, err := docker.NewEngine(newStack()).DeployStack(context.Background(), missing); err == nil {
		t.Fatal("a service depended on something that is not in the plan")
	}
}
