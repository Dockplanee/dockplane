package docker_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
fakeManager adds the creating half of the Engine API to the lifecycle fake.

It records the labels every container was created with, which is what these
tests are about: the identity a container carries is set here, authoritatively,
and is the only thing recovery can read back to find out which configuration a
running container represents.
*/
type fakeManager struct {
	*fakeClient

	/** Labels for each container created, keyed by the name it was given. */
	created map[string]map[string]string
	/** Names passed to ContainerCreate, in order. */
	names []string

	removed  []string
	renames  [][2]string
	startErr error
}

func newManager(inspect container.InspectResponse) *fakeManager {
	return &fakeManager{
		fakeClient: &fakeClient{inspect: inspect},
		created:    map[string]map[string]string{},
	}
}

func (f *fakeManager) ContainerCreate(
	_ context.Context,
	config *container.Config,
	_ *container.HostConfig,
	_ *network.NetworkingConfig,
	_ *ocispec.Platform,
	name string,
) (container.CreateResponse, error) {
	labels := map[string]string{}

	for key, value := range config.Labels {
		labels[key] = value
	}

	f.created[name] = labels
	f.names = append(f.names, name)

	return container.CreateResponse{ID: "created-" + name}, nil
}

func (f *fakeManager) ContainerRemove(_ context.Context, id string, _ container.RemoveOptions) error {
	f.removed = append(f.removed, id)
	return nil
}

func (f *fakeManager) ContainerRename(_ context.Context, id string, name string) error {
	f.renames = append(f.renames, [2]string{id, name})
	return nil
}

func (f *fakeManager) ImageInspect(
	_ context.Context,
	_ string,
	_ ...dockerclient.ImageInspectOption,
) (image.InspectResponse, error) {
	return image.InspectResponse{ID: "sha256:present"}, nil
}

func (f *fakeManager) ImagePull(
	_ context.Context,
	_ string,
	_ image.PullOptions,
) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

func (f *fakeManager) NetworkConnect(_ context.Context, _, _ string, _ *network.EndpointSettings) error {
	return nil
}

func (f *fakeManager) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	f.calls = append(f.calls, "start:"+id)
	return f.startErr
}

func spec() *docker.ContainerSpec {
	return &docker.ContainerSpec{Name: "web", Image: "nginx:1.27"}
}

/*
A created container says which configuration it is.

Not which image or which ports — those can be read off the container itself.
The configuration identity is the one thing that cannot: a replacement may
change nothing but a secret, and the agent never reports environment values at
all. Without this label a control server that crashed mid-replacement would have
no way to tell the old container from the new one.
*/
func TestCreateStampsTheConfigurationItApplied(t *testing.T) {
	manager := newManager(running())

	if _, err := docker.NewEngine(manager).Create(
		context.Background(), spec(), "", "container-x", "config-a",
	); err != nil {
		t.Fatalf("create: %v", err)
	}

	labels := manager.created["web"]

	if labels[docker.LabelDesiredConfigID] != "config-a" {
		t.Errorf("desired config id = %q", labels[docker.LabelDesiredConfigID])
	}

	if labels[docker.LabelContainerID] != "container-x" {
		t.Errorf("container id = %q", labels[docker.LabelContainerID])
	}

	if labels[docker.LabelManaged] != "true" {
		t.Errorf("managed = %q", labels[docker.LabelManaged])
	}
}

/*
The replacement carries the new configuration from the moment it is built.

Stamping it afterwards would leave a window in which a crash produced a running
container claiming the configuration it was replacing.
*/
func TestReplacementCarriesTheNewConfigurationFromTheStart(t *testing.T) {
	manager := newManager(running())

	if _, err := docker.NewEngine(manager).Replace(
		context.Background(), "aaa111", spec(), "", "container-x", "config-b",
	); err != nil {
		t.Fatalf("replace: %v", err)
	}

	// Built under a staging name, because the original still holds the real one.
	labels := manager.created["web.dockplane-new"]

	if labels[docker.LabelDesiredConfigID] != "config-b" {
		t.Errorf("desired config id = %q", labels[docker.LabelDesiredConfigID])
	}

	// The same resource throughout: Docker gives the replacement a new
	// identifier, and this is what says it is still the operator's container.
	if labels[docker.LabelContainerID] != "container-x" {
		t.Errorf("container id = %q", labels[docker.LabelContainerID])
	}
}

/*
A rollback leaves the original saying exactly what it always said.

The original is stopped, renamed and started again, and nothing rewrites its
labels — the agent has no call that could. So a replacement that failed leaves a
container still claiming the configuration that is genuinely running on it, and
recovery reading that label reaches the right answer without being told the
operation failed.
*/
func TestRollbackLeavesTheOriginalConfigurationAlone(t *testing.T) {
	manager := newManager(running())
	manager.startErr = errors.New("the replacement would not start")

	_, err := docker.NewEngine(manager).Replace(
		context.Background(), "aaa111", spec(), "", "container-x", "config-b",
	)

	if err == nil {
		t.Fatal("a replacement that could not start was reported as success")
	}

	// Exactly one container was built, and it was the candidate. The original
	// was never rebuilt, so it cannot have been restamped.
	if len(manager.names) != 1 || manager.names[0] != "web.dockplane-new" {
		t.Fatalf("containers created = %v", manager.names)
	}

	if _, present := manager.created["web"]; present {
		t.Error("the original was recreated during a rollback")
	}

	if labels := manager.created["web.dockplane-new"]; labels[docker.LabelDesiredConfigID] != "config-b" {
		t.Errorf("the candidate carried %q", labels[docker.LabelDesiredConfigID])
	}
}

/*
A caller cannot claim to be a configuration it is not.

The reserved labels are the agent's own, and it sets them from what the control
server resolved. A specification carrying them is refused outright rather than
having them quietly replaced: a caller that believes it set a label and did not
is a caller working from a false picture.
*/
func TestACallerCannotStampAConfigurationIdentity(t *testing.T) {
	for _, reserved := range docker.ReservedLabels {
		t.Run(reserved, func(t *testing.T) {
			claimed := spec()
			claimed.Labels = map[string]string{reserved: "mine"}

			if err := claimed.Validate(); err == nil {
				t.Fatalf("a caller set %s", reserved)
			}
		})
	}
}

/*
The identity labels are set even when there is nothing to say.

An empty configuration identity is not written as an empty label, which would
be a container claiming to have a configuration whose identifier is the empty
string.
*/
func TestAnAbsentIdentityIsNotWrittenAsAnEmptyLabel(t *testing.T) {
	labels := spec().LabelSet("", "", "")

	for _, key := range []string{
		docker.LabelStack,
		docker.LabelContainerID,
		docker.LabelDesiredConfigID,
	} {
		if _, present := labels[key]; present {
			t.Errorf("%s was written with no value to write", key)
		}
	}
}
