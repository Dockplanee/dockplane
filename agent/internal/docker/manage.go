package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

/*
Creating, replacing and removing containers.

Docker cannot change most of a container's configuration in place. A port
binding, a mount, an environment variable and an image are all fixed when the
container is created, so "edit this container" is, underneath, "build the
replacement, put it in place, and keep the original until the replacement is
known to work".

That sequence is the whole of this file. It is written so that a failure at any
step leaves the host with a running container rather than with neither: the
original is stopped but kept, renamed out of the way rather than removed, and
put back if the replacement does not come up.

What this cannot do is undo what a container did while it ran. Configuration is
restored; data is not. A replacement that wrote to a volume has written to it,
and rolling the configuration back does not unwrite it.
*/

// ManagementClient is what creating and replacing a container needs, beyond
// what reading one does.
//
// Still no attach and no exec. Attach is the API that carries standard input,
// and its absence from every interface in this package is what makes a console
// unreachable no matter what a request asks for.
type ManagementClient interface {
	ContainerCreate(
		ctx context.Context,
		config *container.Config,
		hostConfig *container.HostConfig,
		networkingConfig *network.NetworkingConfig,
		platform *ocispec.Platform,
		name string,
	) (container.CreateResponse, error)
	ContainerRemove(ctx context.Context, id string, options container.RemoveOptions) error
	ContainerRename(ctx context.Context, id string, name string) error
	ImageInspect(
		ctx context.Context,
		id string,
		options ...dockerclient.ImageInspectOption,
	) (image.InspectResponse, error)
	ImagePull(ctx context.Context, reference string, options image.PullOptions) (io.ReadCloser, error)
	NetworkConnect(ctx context.Context, networkID, containerID string, config *network.EndpointSettings) error
}

// The real Engine client has to satisfy this, or nothing here reaches Docker.
// Stated as a compile-time assertion because the alternative is finding out at
// runtime, when an operator is waiting for a container.
var _ ManagementClient = (*dockerclient.Client)(nil)

var (
	ErrNameInUse     = errors.New("a container of that name already exists")
	ErrImageNotFound = errors.New("image not found")
	ErrReplaceFailed = errors.New("the replacement did not start")
)

// CreateResult reports what was made.
type CreateResult struct {
	ContainerID string    `json:"containerId"`
	Name        string    `json:"name"`
	Image       string    `json:"image"`
	State       string    `json:"state"`
	ObservedAt  time.Time `json:"observedAt"`
}

// ReplaceResult reports what replaced what, and whether the original is gone.
type ReplaceResult struct {
	ContainerID         string    `json:"containerId"`
	PreviousContainerID string    `json:"previousContainerId"`
	Name                string    `json:"name"`
	Image               string    `json:"image"`
	State               string    `json:"state"`
	RolledBack          bool      `json:"rolledBack"`
	ObservedAt          time.Time `json:"observedAt"`
}

// RemoveResult reports what was removed, and what deliberately was not.
type RemoveResult struct {
	ContainerID string    `json:"containerId"`
	Name        string    `json:"name"`
	VolumesKept bool      `json:"volumesKept"`
	ObservedAt  time.Time `json:"observedAt"`
}

func (e *Engine) management() (ManagementClient, error) {
	client, ok := e.client.(ManagementClient)

	if !ok {
		return nil, fmt.Errorf("%w: this build cannot create containers", ErrUnavailable)
	}

	return client, nil
}

/*
Create builds a container from a specification and starts it.

The specification is validated again here rather than trusted from the caller.
The server validated it too; this is the check that holds when the server is
wrong.
*/
func (e *Engine) Create(
	ctx context.Context,
	spec *ContainerSpec,
	stack string,
	containerID string,
	desiredConfigID string,
) (*CreateResult, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}

	client, err := e.management()

	if err != nil {
		return nil, err
	}

	if err := e.ensureImage(ctx, client, spec.Image); err != nil {
		return nil, err
	}

	id, err := e.create(ctx, client, spec, stack, containerID, desiredConfigID, spec.Name)

	if err != nil {
		return nil, err
	}

	if err := e.connectNetworks(ctx, client, id, spec); err != nil {
		// A container that exists but is not on the networks it was asked for
		// is not what was requested, and leaving it would be worse than not
		// having made it.
		_ = client.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
		return nil, err
	}

	if err := e.client.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		_ = client.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
		return nil, classify(err)
	}

	observed, err := e.observe(ctx, id)

	if err != nil {
		return nil, err
	}

	return &CreateResult{
		ContainerID: id,
		Name:        spec.Name,
		Image:       spec.Image,
		State:       observed.State,
		ObservedAt:  observed.ObservedAt,
	}, nil
}

/*
Replace builds the replacement first and keeps the original until it works.

The order matters, and it is this:

 1. read the original, so there is something to put back
 2. make sure the image is on the host, before anything is taken down
 3. create the replacement under a temporary name — two containers may not
    hold one name, so the original keeps it for now
 4. stop the original and rename it aside, still there, still removable
 5. give the replacement the name, connect it, start it
 6. wait for it to be running
 7. only now remove the original

A failure before step 4 leaves the original untouched. A failure after it puts
the original back under its own name and starts it again, and says so in the
result rather than reporting a success that did not happen.
*/
func (e *Engine) Replace(
	ctx context.Context,
	currentID string,
	spec *ContainerSpec,
	stack string,
	containerID string,
	desiredConfigID string,
) (*ReplaceResult, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}

	client, err := e.management()

	if err != nil {
		return nil, err
	}

	original, err := e.client.ContainerInspect(ctx, currentID)

	if err != nil {
		return nil, classify(err)
	}

	wasRunning := original.State != nil && original.State.Running

	if err := e.ensureImage(ctx, client, spec.Image); err != nil {
		return nil, err
	}

	// Two containers cannot hold one name, and the original still holds it.
	staging := spec.Name + ".dockplane-new"
	_ = client.ContainerRemove(ctx, staging, container.RemoveOptions{Force: true})

	replacementID, err := e.create(ctx, client, spec, stack, containerID, desiredConfigID, staging)

	if err != nil {
		return nil, err
	}

	// From here the original is disturbed, so every failure path puts it back.
	retired := spec.Name + ".dockplane-old"
	_ = client.ContainerRemove(ctx, retired, container.RemoveOptions{Force: true})

	restore := func() {
		_ = client.ContainerRemove(ctx, replacementID, container.RemoveOptions{Force: true})
		_ = client.ContainerRename(ctx, original.ID, spec.Name)

		if wasRunning {
			_ = e.client.ContainerStart(ctx, original.ID, container.StartOptions{})
		}
	}

	if err := e.client.ContainerStop(ctx, original.ID, container.StopOptions{}); err != nil {
		_ = client.ContainerRemove(ctx, replacementID, container.RemoveOptions{Force: true})
		return nil, classify(err)
	}

	if err := client.ContainerRename(ctx, original.ID, retired); err != nil {
		_ = client.ContainerRemove(ctx, replacementID, container.RemoveOptions{Force: true})

		if wasRunning {
			_ = e.client.ContainerStart(ctx, original.ID, container.StartOptions{})
		}

		return nil, classify(err)
	}

	if err := client.ContainerRename(ctx, replacementID, spec.Name); err != nil {
		restore()
		return nil, classify(err)
	}

	if err := e.connectNetworks(ctx, client, replacementID, spec); err != nil {
		restore()
		return nil, err
	}

	if err := e.client.ContainerStart(ctx, replacementID, container.StartOptions{}); err != nil {
		restore()
		return nil, fmt.Errorf("%w: %v", ErrReplaceFailed, classify(err))
	}

	observed, err := e.observe(ctx, replacementID)

	if err != nil || observed.State != "running" {
		restore()

		return &ReplaceResult{
			ContainerID:         original.ID,
			PreviousContainerID: original.ID,
			Name:                spec.Name,
			RolledBack:          true,
			ObservedAt:          time.Now().UTC(),
		}, fmt.Errorf("%w: it did not stay running", ErrReplaceFailed)
	}

	/*
	 * The original goes only now, and its volumes stay.
	 *
	 * A named volume outlives the container that mounted it; removing one here
	 * would delete an operator's data as a side effect of an edit, which is not
	 * something an edit is allowed to do.
	 */
	_ = client.ContainerRemove(ctx, original.ID, container.RemoveOptions{RemoveVolumes: false})

	return &ReplaceResult{
		ContainerID:         replacementID,
		PreviousContainerID: original.ID,
		Name:                spec.Name,
		Image:               spec.Image,
		State:               observed.State,
		ObservedAt:          observed.ObservedAt,
	}, nil
}

/*
Remove deletes a container and keeps its volumes.

Anonymous volumes are kept too. Docker would remove them on request, and the
difference between an anonymous volume and a named one is not a difference an
operator should discover by losing data.
*/
func (e *Engine) Remove(ctx context.Context, id string, force bool) (*RemoveResult, error) {
	client, err := e.management()

	if err != nil {
		return nil, err
	}

	inspected, err := e.client.ContainerInspect(ctx, id)

	if err != nil {
		return nil, classify(err)
	}

	options := container.RemoveOptions{RemoveVolumes: false, Force: force}

	if err := client.ContainerRemove(ctx, id, options); err != nil {
		return nil, classify(err)
	}

	return &RemoveResult{
		ContainerID: inspected.ID,
		Name:        strings.TrimPrefix(inspected.Name, "/"),
		VolumesKept: true,
		ObservedAt:  time.Now().UTC(),
	}, nil
}

func (e *Engine) create(
	ctx context.Context,
	client ManagementClient,
	spec *ContainerSpec,
	stack string,
	containerID string,
	desiredConfigID string,
	name string,
) (string, error) {
	return e.createWithLabels(ctx, client, spec, spec.LabelSet(stack, containerID, desiredConfigID), name)
}

/*
Builds a container with a label set the caller has already decided.

A stack's containers carry more identity than a standalone one — which stack,
which revision, which service — and that is worked out where a stack is
understood rather than here. Everything else about creating a container is the
same, which is why it is the same code.
*/
func (e *Engine) createWithLabels(
	ctx context.Context,
	client ManagementClient,
	spec *ContainerSpec,
	labels map[string]string,
	name string,
) (string, error) {
	config := &container.Config{
		Image:    spec.Image,
		Env:      spec.SortedEnv(),
		Labels:   labels,
		Hostname: spec.Hostname,
	}

	if len(spec.Command) > 0 {
		config.Cmd = spec.Command
	}

	if len(spec.Entrypoint) > 0 {
		config.Entrypoint = spec.Entrypoint
	}

	exposed, bindings, err := portConfiguration(spec)

	if err != nil {
		return "", err
	}

	config.ExposedPorts = exposed

	if spec.Healthcheck != nil {
		config.Healthcheck = &container.HealthConfig{
			Test:        spec.Healthcheck.Test,
			Interval:    time.Duration(spec.Healthcheck.IntervalMS) * time.Millisecond,
			Timeout:     time.Duration(spec.Healthcheck.TimeoutMS) * time.Millisecond,
			StartPeriod: time.Duration(spec.Healthcheck.StartPerMS) * time.Millisecond,
			Retries:     spec.Healthcheck.Retries,
		}
	}

	hostConfig := &container.HostConfig{
		PortBindings: bindings,
		Mounts:       mountConfiguration(spec),
		RestartPolicy: container.RestartPolicy{
			Name: container.RestartPolicyMode(spec.RestartPolicy),
		},
	}

	created, err := client.ContainerCreate(ctx, config, hostConfig, nil, nil, name)

	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "already in use") {
			return "", fmt.Errorf("%w: %s", ErrNameInUse, name)
		}

		return "", classify(err)
	}

	return created.ID, nil
}

func portConfiguration(spec *ContainerSpec) (nat.PortSet, nat.PortMap, error) {
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}

	for _, binding := range spec.Ports {
		port, err := nat.NewPort(binding.Protocol, strconv.Itoa(int(binding.ContainerPort)))

		if err != nil {
			return nil, nil, fmt.Errorf("%w: port %d", ErrInvalidSpec, binding.ContainerPort)
		}

		exposed[port] = struct{}{}

		if binding.HostPort == 0 {
			// Exposed without being published, which is what Compose means by a
			// port with no host side.
			continue
		}

		bindings[port] = append(bindings[port], nat.PortBinding{
			HostIP:   binding.HostIP,
			HostPort: strconv.Itoa(int(binding.HostPort)),
		})
	}

	return exposed, bindings, nil
}

func mountConfiguration(spec *ContainerSpec) []mount.Mount {
	mounts := make([]mount.Mount, 0, len(spec.Mounts))

	for _, requested := range spec.Mounts {
		kind := mount.TypeVolume

		if requested.Type == "bind" {
			kind = mount.TypeBind
		}

		mounts = append(mounts, mount.Mount{
			Type:     kind,
			Source:   requested.Source,
			Target:   requested.Target,
			ReadOnly: requested.ReadOnly,
		})
	}

	return mounts
}

func (e *Engine) connectNetworks(
	ctx context.Context,
	client ManagementClient,
	id string,
	spec *ContainerSpec,
) error {
	for _, name := range spec.Networks {
		if err := client.NetworkConnect(ctx, name, id, nil); err != nil {
			return fmt.Errorf("%w: network %q: %v", ErrDockerFailedOperation, name, err)
		}
	}

	return nil
}

// ErrDockerFailedOperation names an engine refusal the agent has no more
// specific word for.
var ErrDockerFailedOperation = errors.New("the Docker Engine refused the operation")

/*
ensureImage makes the image available before anything is taken down.

Pulling after the original has been stopped would mean a slow or failing
registry leaves the host with nothing running. It is pulled only when it is
absent: an image already on the host is the one the operator is replacing from,
and re-pulling it would silently change what a tag means mid-edit.
*/
func (e *Engine) ensureImage(ctx context.Context, client ManagementClient, reference string) error {
	if _, err := client.ImageInspect(ctx, reference); err == nil {
		return nil
	}

	body, err := client.ImagePull(ctx, reference, image.PullOptions{})

	if err != nil {
		return fmt.Errorf("%w: %s", ErrImageNotFound, reference)
	}

	defer func() { _ = body.Close() }()

	// The pull is only complete once its stream has been consumed.
	if _, err := io.Copy(io.Discard, body); err != nil {
		return fmt.Errorf("%w: %s", ErrImageNotFound, reference)
	}

	if _, err := client.ImageInspect(ctx, reference); err != nil {
		return fmt.Errorf("%w: %s", ErrImageNotFound, reference)
	}

	return nil
}
