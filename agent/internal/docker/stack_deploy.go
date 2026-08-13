package docker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	dockerclient "github.com/docker/docker/client"
)

/*
Putting a stack on the host for the first time.

The order is the point. Everything that can fail without changing anything
happens first — the plan is checked, the names on the host are checked, the
images are pulled — and only then does anything get created. A deployment that
is going to fail because an image does not exist should fail before it has made
a network, not after it has started half the services.

Nothing here adopts. A container, volume or network whose name this stack wants
but whose labels say it belongs to something else stops the deployment. Renaming
or removing it would be destroying something on the strength of a name.

Volumes are never removed by this code, in any path. A volume that was created a
second ago may already hold data, because a container that mounted it may
already have written some — and a cleanup that could delete data is not a
cleanup, it is a data loss with good intentions.
*/

// StackClient is everything deploying a stack needs from Docker.
//
// Wider than the lifecycle client and still deliberately small: there is no
// operation here that removes a volume, and none that runs a command.
type StackClient interface {
	ManagementClient

	NetworkList(ctx context.Context, options network.ListOptions) ([]network.Summary, error)
	NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error)
	NetworkRemove(ctx context.Context, networkID string) error

	VolumeList(ctx context.Context, options volume.ListOptions) (volume.ListResponse, error)
	VolumeCreate(ctx context.Context, options volume.CreateOptions) (volume.Volume, error)
}

// The real client has to satisfy this, or a deployment fails at runtime rather
// than at compile time.
var _ StackClient = (*dockerclient.Client)(nil)

// StackDeployResult is what the server learns from one attempt.
//
// Never the plan and never a value from it: a service name, a resource name and
// a code are enough to say what happened and to say where.
type StackDeployResult struct {
	StackID    string                `json:"stackId"`
	RevisionID string                `json:"revisionId"`
	Services   []StackServiceOutcome `json:"services"`
	// True when every service in the plan is running.
	Complete   bool      `json:"complete"`
	ObservedAt time.Time `json:"observedAt"`
}

type StackServiceOutcome struct {
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId"`
	DockerID    string `json:"dockerId,omitempty"`
	State       string `json:"state,omitempty"`
	// Set when this service is why the deployment did not complete.
	ErrorCode string `json:"errorCode,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

/*
DeployStack creates a stack that is not on this host yet.

Returns a result whether or not everything succeeded. A deployment that started
some services and then failed is a state somebody has to look at, not an error
to throw away — the result says which services are running and which is not, and
nothing is torn down on the way out.
*/
func (e *Engine) DeployStack(ctx context.Context, plan *StackPlan) (*StackDeployResult, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}

	client, err := e.stack()

	if err != nil {
		return nil, err
	}

	order, err := plan.StartOrder()

	if err != nil {
		return nil, err
	}

	// --- nothing is created until all of this passes -----------------------
	if err := e.checkNamesAreFree(ctx, client, plan); err != nil {
		return nil, err
	}

	for index := range plan.Services {
		if err := e.ensureImage(ctx, client, plan.Services[index].Spec.Image); err != nil {
			return nil, fmt.Errorf("%s: %w", plan.Services[index].ServiceName, err)
		}
	}

	// --- from here the host changes ----------------------------------------
	created, err := e.ensureNetworks(ctx, client, plan)

	if err != nil {
		// Networks made by this attempt and nothing else. A network carries no
		// data, so removing one this attempt created loses nothing.
		e.removeNetworks(ctx, client, created)

		return nil, err
	}

	if err := e.ensureVolumes(ctx, client, plan); err != nil {
		e.removeNetworks(ctx, client, created)

		return nil, err
	}

	result := &StackDeployResult{
		StackID:    plan.StackID,
		RevisionID: plan.RevisionID,
		ObservedAt: time.Now().UTC(),
	}

	byName := map[string]*StackService{}

	for index := range plan.Services {
		byName[plan.Services[index].ServiceName] = &plan.Services[index]
	}

	for _, name := range order {
		service := byName[name]
		outcome := e.startService(ctx, client, plan, service)

		result.Services = append(result.Services, outcome)

		if outcome.ErrorCode != "" {
			/*
			 * Stop at the first service that fails.
			 *
			 * What has already started stays started: a container that ran may
			 * have written to a volume, and unwinding that is not something
			 * this can do safely. The result says what exists, and a person
			 * decides.
			 */
			return result, nil
		}
	}

	result.Complete = true

	return result, nil
}

func (e *Engine) stack() (StackClient, error) {
	client, ok := e.client.(StackClient)

	if !ok {
		return nil, fmt.Errorf("%w: this build cannot deploy stacks", ErrUnavailable)
	}

	return client, nil
}

/*
Whether anything on the host already has a name this stack wants.

Checked for every container, volume and network before the first one is created,
so a collision halfway through cannot leave a stack half-made. A name held by
something this stack already owns is fine — that is a redeployment finding its
own resources — and a name held by anything else stops everything.
*/
func (e *Engine) checkNamesAreFree(ctx context.Context, client StackClient, plan *StackPlan) error {
	existing, err := e.client.ContainerList(ctx, container.ListOptions{All: true})

	if err != nil {
		return classify(err)
	}

	byName := map[string]container.Summary{}

	for _, summary := range existing {
		for _, name := range summary.Names {
			byName[trimName(name)] = summary
		}
	}

	for _, service := range plan.Services {
		found, present := byName[service.ContainerName]

		if !present {
			continue
		}

		if !ownedByStack(found.Labels, plan.StackID, LabelStackService, service.ServiceName) {
			return fmt.Errorf(
				"%w: a container called %s is not this stack's",
				ErrStackResourceConflict,
				service.ContainerName,
			)
		}
	}

	networks, err := client.NetworkList(ctx, network.ListOptions{})

	if err != nil {
		return classify(err)
	}

	for _, wanted := range plan.Networks {
		for _, found := range networks {
			if found.Name != wanted.DockerName {
				continue
			}

			if !ownedByStack(found.Labels, plan.StackID, LabelStackNetwork, wanted.Name) {
				return fmt.Errorf(
					"%w: a network called %s is not this stack's",
					ErrStackResourceConflict,
					wanted.DockerName,
				)
			}
		}
	}

	volumes, err := client.VolumeList(ctx, volume.ListOptions{Filters: filters.NewArgs()})

	if err != nil {
		return classify(err)
	}

	for _, wanted := range plan.Volumes {
		for _, found := range volumes.Volumes {
			if found == nil || found.Name != wanted.DockerName {
				continue
			}

			/*
			 * The most dangerous case in this file.
			 *
			 * A volume of the right name that Dockplane did not create for this
			 * stack holds somebody's data. Mounting it into a new stack because
			 * the names matched would hand one workload another's database.
			 */
			if !ownedByStack(found.Labels, plan.StackID, LabelStackVolume, wanted.Name) {
				return fmt.Errorf(
					"%w: a volume called %s is not this stack's",
					ErrStackResourceConflict,
					wanted.DockerName,
				)
			}
		}
	}

	return nil
}

/** Creates the networks this stack needs, and reports which it made. */
func (e *Engine) ensureNetworks(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
) ([]string, error) {
	existing, err := client.NetworkList(ctx, network.ListOptions{})

	if err != nil {
		return nil, classify(err)
	}

	present := map[string]bool{}

	for _, found := range existing {
		present[found.Name] = true
	}

	var created []string

	for _, wanted := range plan.Networks {
		if present[wanted.DockerName] {
			// Already checked as this stack's by the preflight.
			continue
		}

		options := network.CreateOptions{
			Driver: wanted.Driver,
			Labels: map[string]string{
				LabelManaged:      "true",
				LabelStackID:      plan.StackID,
				LabelStackNetwork: wanted.Name,
			},
		}

		if _, err := client.NetworkCreate(ctx, wanted.DockerName, options); err != nil {
			return created, classify(err)
		}

		created = append(created, wanted.DockerName)
	}

	return created, nil
}

/*
Removes networks this attempt created, and only those.

Called when a deployment fails before any container has started. A network holds
nothing, so this loses nothing — which is exactly why the same is not done for
volumes.
*/
func (e *Engine) removeNetworks(ctx context.Context, client StackClient, names []string) {
	for _, name := range names {
		_ = client.NetworkRemove(ctx, name)
	}
}

/*
Creates the volumes this stack needs.

Never removed on a failure path, here or anywhere else. A volume created a
moment ago may already hold data, and a cleanup that could delete it is not a
cleanup.
*/
func (e *Engine) ensureVolumes(ctx context.Context, client StackClient, plan *StackPlan) error {
	existing, err := client.VolumeList(ctx, volume.ListOptions{Filters: filters.NewArgs()})

	if err != nil {
		return classify(err)
	}

	present := map[string]bool{}

	for _, found := range existing.Volumes {
		if found != nil {
			present[found.Name] = true
		}
	}

	for _, wanted := range plan.Volumes {
		if present[wanted.DockerName] {
			continue
		}

		options := volume.CreateOptions{
			Name:   wanted.DockerName,
			Driver: wanted.Driver,
			Labels: map[string]string{
				LabelManaged:     "true",
				LabelStackID:     plan.StackID,
				LabelStackVolume: wanted.Name,
			},
		}

		if _, err := client.VolumeCreate(ctx, options); err != nil {
			return classify(err)
		}
	}

	return nil
}

/** Builds one service's container and starts it. */
func (e *Engine) startService(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
	service *StackService,
) StackServiceOutcome {
	outcome := StackServiceOutcome{
		ServiceName: service.ServiceName,
		ContainerID: service.ContainerID,
	}

	spec := service.Spec
	spec.Name = service.ContainerName

	id, err := e.createWithLabels(ctx, client, &spec, plan.serviceLabels(service), service.ContainerName)

	if err != nil {
		outcome.ErrorCode = codeFor(err)
		outcome.Detail = service.ServiceName

		return outcome
	}

	outcome.DockerID = id

	if err := e.connectNetworks(ctx, client, id, &spec); err != nil {
		outcome.ErrorCode = codeFor(err)
		outcome.Detail = service.ServiceName

		return outcome
	}

	if err := e.client.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		outcome.ErrorCode = codeFor(classify(err))
		outcome.Detail = service.ServiceName

		return outcome
	}

	observed, err := e.observe(ctx, id)

	if err != nil {
		outcome.ErrorCode = codeFor(err)
		outcome.Detail = service.ServiceName

		return outcome
	}

	outcome.State = observed.State

	/*
	 * Running is the bar, not healthy.
	 *
	 * A health check is applied to the container and reported as observed state
	 * afterwards. Waiting for it here would make a deployment's success depend
	 * on a timeout somebody chose, and a slow-starting database would look like
	 * a failed deployment.
	 */
	if observed.State != "running" {
		outcome.ErrorCode = "CONTAINER_NOT_RUNNING"
		outcome.Detail = service.ServiceName
	}

	return outcome
}

/** What the server should call this failure, without quoting anything. */
func codeFor(err error) string {
	switch {
	case errors.Is(err, ErrImageNotFound):
		return "IMAGE_PULL_FAILED"
	case errors.Is(err, ErrNameInUse):
		return "RESOURCE_NAME_CONFLICT"
	case errors.Is(err, ErrStackResourceConflict):
		return "RESOURCE_NAME_CONFLICT"
	case errors.Is(err, ErrInvalidSpec):
		return "INVALID_CONTAINER_SPEC"
	case errors.Is(err, ErrPermission):
		return "DOCKER_PERMISSION_DENIED"
	case errors.Is(err, ErrUnavailable):
		return "DOCKER_UNAVAILABLE"
	default:
		return "DOCKER_OPERATION_FAILED"
	}
}

func trimName(name string) string {
	if len(name) > 0 && name[0] == '/' {
		return name[1:]
	}

	return name
}
