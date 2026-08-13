package docker

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	dockerclient "github.com/docker/docker/client"
)

/*
Putting a revision of a stack on the host, whatever is there now.

One operation covers all of it: a stack that has never run, a stack moving to a
newer revision, a stack going back to an older one, and a stack somebody is
converging after a deployment that stopped halfway. They differ only in what the
host happens to hold, and the host is read rather than assumed.

The order is the point. Everything that can fail without changing anything
happens first — the plan is checked, what the host has is checked, the volumes
the running stack needs are checked, every image is pulled — and only then is
the first container stopped. A deployment that is going to fail because an image
does not exist must fail before it has taken a database down.

A revision is applied as a whole. Every service is recreated, even one whose
configuration did not change, so that afterwards each running container carries
the revision it belongs to and the answer to "is this stack revision B" is a
label rather than an inference. It costs a short interruption, which is stated
in the documentation rather than engineered around.

Nothing here adopts and nothing here deletes data. A container, volume or
network whose name this stack wants but whose labels say it belongs to something
else stops the operation. Volumes are never removed on any path — not on
success, not on failure, not when a revision stops using one.
*/

// StackClient is everything applying a stack needs from Docker.
//
// Wider than the lifecycle client and still deliberately small: there is no
// operation here that removes a volume, and none that runs a command.
type StackClient interface {
	ManagementClient

	NetworkList(ctx context.Context, options network.ListOptions) ([]network.Summary, error)
	NetworkCreate(ctx context.Context, name string, options network.CreateOptions) (network.CreateResponse, error)
	NetworkRemove(ctx context.Context, networkID string) error
	NetworkDisconnect(ctx context.Context, networkID, containerID string, force bool) error

	VolumeList(ctx context.Context, options volume.ListOptions) (volume.ListResponse, error)
	VolumeCreate(ctx context.Context, options volume.CreateOptions) (volume.Volume, error)
}

// The real client has to satisfy this, or an apply fails at runtime rather than
// at compile time.
var _ StackClient = (*dockerclient.Client)(nil)

/** What one attempt did to the host. */
const (
	// Every service of the target revision is running.
	OutcomeApplied = "target_applied"
	// The target did not come up and the host was put back as it was.
	OutcomeRolledBack = "apply_failed_rollback_succeeded"
	// The target did not come up and putting the host back did not fully work.
	OutcomeRollbackIncomplete = "apply_failed_rollback_incomplete"
)

// StackApplyResult is what the server learns from one attempt.
//
// Never the plan and never a value from it: a service name, a resource name and
// a code are enough to say what happened and where.
type StackApplyResult struct {
	StackID    string `json:"stackId"`
	RevisionID string `json:"revisionId"`
	// One of the outcomes above. The server reads the host anyway; this says
	// what the agent believes it did, which is worth recording and not worth
	// trusting on its own.
	Outcome  string                `json:"outcome"`
	Services []StackServiceOutcome `json:"services"`
	// True when every service in the plan is running.
	Complete bool `json:"complete"`
	// Set when the attempt failed: which service stopped it.
	FailedService string    `json:"failedService,omitempty"`
	ErrorCode     string    `json:"errorCode,omitempty"`
	ObservedAt    time.Time `json:"observedAt"`
}

type StackServiceOutcome struct {
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId"`
	DockerID    string `json:"dockerId,omitempty"`
	State       string `json:"state,omitempty"`
	// Set when this service is why the attempt did not complete.
	ErrorCode string `json:"errorCode,omitempty"`
}

/*
A container of this stack as it was before the attempt touched it.

Held in this process for the length of one call and nowhere else. It carries no
environment, no command and no configuration — only what is needed to put the
container back exactly as it was found: where it was on the network, what it was
called, and whether it was running.
*/
type rollbackCandidate struct {
	dockerID   string
	name       string
	service    string
	wasRunning bool
	networks   map[string]*network.EndpointSettings
	// The name it was moved to so the target could take its own.
	stagedName string
}

/*
ApplyStack moves this stack to the revision the plan describes.

Returns a result whether or not the target came up. An attempt that failed and
was undone is not an error to throw away — it is a state somebody has to be told
about, and the difference between "put back" and "not fully put back" is the
most important thing in the answer.
*/
func (e *Engine) ApplyStack(ctx context.Context, plan *StackPlan) (*StackApplyResult, error) {
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

	// --- nothing on the host changes until all of this passes ---------------
	candidates, err := e.stackCandidates(ctx, plan)

	if err != nil {
		return nil, err
	}

	if err := e.checkNamesAreFree(ctx, client, plan, candidates); err != nil {
		return nil, err
	}

	if err := e.checkVolumesArePresent(ctx, client, plan, candidates); err != nil {
		return nil, err
	}

	for index := range plan.Services {
		if err := e.ensureImage(ctx, client, plan.Services[index].Spec.Image); err != nil {
			return nil, fmt.Errorf("%s: %w", plan.Services[index].ServiceName, err)
		}
	}

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

	// --- from here the stack is disturbed, and every failure path puts it back
	if err := e.stageAside(ctx, client, plan, candidates); err != nil {
		e.restore(ctx, client, candidates)

		return nil, err
	}

	result := &StackApplyResult{
		StackID:    plan.StackID,
		RevisionID: plan.RevisionID,
		ObservedAt: time.Now().UTC(),
	}

	byName := map[string]*StackService{}

	for index := range plan.Services {
		byName[plan.Services[index].ServiceName] = &plan.Services[index]
	}

	for _, name := range order {
		outcome := e.startService(ctx, client, plan, byName[name])

		result.Services = append(result.Services, outcome)

		if outcome.ErrorCode != "" {
			result.FailedService = name
			result.ErrorCode = outcome.ErrorCode
			result.Outcome = e.undo(ctx, client, plan, result.Services, candidates)
			result.ObservedAt = time.Now().UTC()

			return result, nil
		}
	}

	/*
	 * The target is up, so the containers it replaced go now.
	 *
	 * Only now, and with their volumes kept. A named volume outlives the
	 * container that mounted it, and the whole point of holding these until
	 * this moment is that up to it they were the way back.
	 */
	for _, candidate := range candidates {
		_ = client.ContainerRemove(ctx, candidate.dockerID, container.RemoveOptions{RemoveVolumes: false})
	}

	result.Complete = true
	result.Outcome = OutcomeApplied
	result.ObservedAt = time.Now().UTC()

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
What this stack already has on the host.

Read from labels, which is the only thing that can say which stack a container
belongs to. Two containers claiming one service, or a container claiming a
service under an identity the control server did not give it, stop the operation
here: applying a revision over that would mean choosing which of two containers
is the real one.

A container of this stack whose service is not in the target is included. It is
a service being removed, and it is a way back until the target is up.
*/
func (e *Engine) stackCandidates(ctx context.Context, plan *StackPlan) ([]rollbackCandidate, error) {
	listed, err := e.client.ContainerList(ctx, container.ListOptions{All: true})

	if err != nil {
		return nil, classify(err)
	}

	wanted := map[string]string{}

	for _, service := range plan.Services {
		wanted[service.ServiceName] = service.ContainerID
	}

	claims := map[string]int{}
	var candidates []rollbackCandidate

	for _, summary := range listed {
		if summary.Labels[LabelManaged] != "true" || summary.Labels[LabelStackID] != plan.StackID {
			continue
		}

		service := summary.Labels[LabelStackService]

		if service == "" {
			return nil, fmt.Errorf(
				"%w: a container of this stack names no service",
				ErrStackStateAmbiguous,
			)
		}

		claims[service]++

		if claims[service] > 1 {
			return nil, fmt.Errorf(
				"%w: more than one container is service %s",
				ErrStackStateAmbiguous,
				service,
			)
		}

		/*
		 * A service the target has, held by a container the control server does
		 * not know as that service. Its identity is what makes the operator's
		 * container the same resource across revisions, and a mismatch means
		 * the two sides disagree about which container that is.
		 */
		if identity, present := wanted[service]; present &&
			summary.Labels[LabelContainerID] != identity {
			return nil, fmt.Errorf(
				"%w: service %s is held by a container with another identity",
				ErrStackStateAmbiguous,
				service,
			)
		}

		inspected, err := e.client.ContainerInspect(ctx, summary.ID)

		if err != nil {
			return nil, classify(err)
		}

		candidates = append(candidates, rollbackCandidate{
			dockerID:   summary.ID,
			name:       trimName(inspected.Name),
			service:    service,
			wasRunning: inspected.State != nil && inspected.State.Running,
			networks:   attachments(&inspected),
		})
	}

	// Stable across runs, so two applies of one plan do the same thing in the
	// same sequence and a diagnostic reads the same way twice.
	sort.Slice(candidates, func(left, right int) bool {
		return candidates[left].service < candidates[right].service
	})

	return candidates, nil
}

/** Where a container sits on the network, so it can be put back there. */
func attachments(inspected *container.InspectResponse) map[string]*network.EndpointSettings {
	found := map[string]*network.EndpointSettings{}

	if inspected.NetworkSettings == nil {
		return found
	}

	for name, endpoint := range inspected.NetworkSettings.Networks {
		if endpoint == nil {
			continue
		}

		// The aliases only. An endpoint carries addresses Docker assigns, and
		// asking for those back would be asking for an address that is taken.
		found[name] = &network.EndpointSettings{Aliases: append([]string{}, endpoint.Aliases...)}
	}

	return found
}

/*
Whether anything on the host already has a name this revision wants.

A name held by one of this stack's own containers is fine — that is the service
being replaced, and it is moved aside before the new one is created. A name held
by anything else stops everything.
*/
func (e *Engine) checkNamesAreFree(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
	candidates []rollbackCandidate,
) error {
	existing, err := e.client.ContainerList(ctx, container.ListOptions{All: true})

	if err != nil {
		return classify(err)
	}

	ours := map[string]bool{}

	for _, candidate := range candidates {
		ours[candidate.dockerID] = true
	}

	byName := map[string]container.Summary{}

	for _, summary := range existing {
		for _, name := range summary.Names {
			byName[trimName(name)] = summary
		}
	}

	for _, service := range plan.Services {
		found, present := byName[service.ContainerName]

		if !present || ours[found.ID] {
			continue
		}

		return fmt.Errorf(
			"%w: a container called %s is not this stack's",
			ErrStackResourceConflict,
			service.ContainerName,
		)
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
			 * stack holds somebody's data. Mounting it into this stack because
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

/*
Whether the volumes the running stack mounts are still there.

The case this exists for: a volume was removed on the host, by hand or by
something else, and a redeployment would create an empty one of the same name
and start the stack on top of it. Everything would look successful and the data
would be gone. So a volume that the containers being replaced are mounting, and
that Docker no longer has, stops the operation before anything is touched.

Only volumes this stack owns are checked. A container may mount something an
operator manages themselves, and that is not Dockplane's to have an opinion on.
*/
func (e *Engine) checkVolumesArePresent(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
	candidates []rollbackCandidate,
) error {
	volumes, err := client.VolumeList(ctx, volume.ListOptions{Filters: filters.NewArgs()})

	if err != nil {
		return classify(err)
	}

	present := map[string]bool{}

	for _, found := range volumes.Volumes {
		if found != nil {
			present[found.Name] = true
		}
	}

	/*
	 * A volume the stack was already using.
	 *
	 * The control server marks these, because it is the side that knows what the
	 * revision being replaced needed. A volume that is new to this revision is
	 * created; one that should be here and is not stops the operation.
	 */
	for _, wanted := range plan.Volumes {
		if wanted.MustExist && !present[wanted.DockerName] {
			return fmt.Errorf(
				"%w: %s, which this stack was already using",
				ErrStackVolumeMissing,
				wanted.DockerName,
			)
		}
	}

	// And whatever the containers being replaced are actually mounting, which
	// catches a volume no revision summary happens to name.
	for _, candidate := range candidates {
		inspected, err := e.client.ContainerInspect(ctx, candidate.dockerID)

		if err != nil {
			return classify(err)
		}

		for _, mount := range inspected.Mounts {
			if mount.Type != "volume" || mount.Name == "" || present[mount.Name] {
				continue
			}

			return fmt.Errorf(
				"%w: %s, which service %s mounts",
				ErrStackVolumeMissing,
				mount.Name,
				candidate.service,
			)
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

Called when an attempt fails before any container has been touched. A network
holds nothing, so this loses nothing — which is exactly why the same is not done
for volumes.
*/
func (e *Engine) removeNetworks(ctx context.Context, client StackClient, names []string) {
	for _, name := range names {
		_ = client.NetworkRemove(ctx, name)
	}
}

/*
Creates the volumes this revision needs.

Never removed on a failure path, here or anywhere else, and never removed
because a revision stopped using one. A volume created a moment ago may already
hold data, and a cleanup that could delete it is not a cleanup.
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

/*
Moves what is running out of the way, without destroying it.

Three things, in this order, and none of them is a removal. The containers are
stopped, so nothing of the old revision is still writing. They are renamed, so
the names the target wants are free. And they are disconnected from the stack's
networks, so the service aliases they hold are free too — a stopped container
keeps its endpoint, and a target container asking for the same alias on the same
network would be refused by Docker.

Everything needed to put them back was read before any of this.
*/
func (e *Engine) stageAside(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
	candidates []rollbackCandidate,
) error {
	for index := range candidates {
		candidate := &candidates[index]

		if candidate.wasRunning {
			if err := e.client.ContainerStop(ctx, candidate.dockerID, container.StopOptions{}); err != nil {
				return classify(err)
			}
		}

		staged := stagedName(plan.RevisionID, candidate.service)

		if err := client.ContainerRename(ctx, candidate.dockerID, staged); err != nil {
			return classify(err)
		}

		candidate.stagedName = staged

		for name := range candidate.networks {
			if err := client.NetworkDisconnect(ctx, name, candidate.dockerID, false); err != nil {
				return classify(err)
			}
		}
	}

	return nil
}

/*
A name for a container that has been moved aside.

Unique to this attempt and to this service, so two containers cannot collide
while being staged and a person reading `docker ps` can see what happened. It
carries the revision being applied and nothing from the configuration.
*/
func stagedName(revisionID string, service string) string {
	short := revisionID

	if len(short) > 8 {
		short = short[:8]
	}

	return fmt.Sprintf("dockplane-staged-%s-%s", short, service)
}

/*
Puts the host back the way it was found.

Called when the target could not be brought up. What it undoes is this attempt
and nothing else: the containers it created are removed, and the ones it moved
aside are reconnected, renamed and started exactly as they were. A container
that was stopped before the attempt is left stopped — restoring means restoring,
not improving.

Reports whether it managed all of it. "Put back" and "not entirely put back" are
different states for an operator, and claiming the first when the second is true
would be the most misleading thing this file could say.
*/
func (e *Engine) undo(
	ctx context.Context,
	client StackClient,
	plan *StackPlan,
	started []StackServiceOutcome,
	candidates []rollbackCandidate,
) string {
	complete := true

	// The containers this attempt created, in reverse order of creation.
	for index := len(started) - 1; index >= 0; index-- {
		outcome := started[index]

		if outcome.DockerID == "" {
			continue
		}

		_ = e.client.ContainerStop(ctx, outcome.DockerID, container.StopOptions{})

		if err := client.ContainerRemove(
			ctx,
			outcome.DockerID,
			container.RemoveOptions{RemoveVolumes: false, Force: true},
		); err != nil {
			complete = false
		}
	}

	if !e.restore(ctx, client, candidates) {
		complete = false
	}

	_ = plan

	if complete {
		return OutcomeRolledBack
	}

	return OutcomeRollbackIncomplete
}

/** Reconnects, renames and restarts what was moved aside. Reports success. */
func (e *Engine) restore(
	ctx context.Context,
	client StackClient,
	candidates []rollbackCandidate,
) bool {
	complete := true

	for index := range candidates {
		candidate := &candidates[index]

		for name, endpoint := range candidate.networks {
			if err := client.NetworkConnect(ctx, name, candidate.dockerID, endpoint); err != nil {
				complete = false
			}
		}

		if candidate.stagedName != "" {
			if err := client.ContainerRename(ctx, candidate.dockerID, candidate.name); err != nil {
				complete = false
				continue
			}

			candidate.stagedName = ""
		}

		if candidate.wasRunning {
			if err := e.client.ContainerStart(ctx, candidate.dockerID, container.StartOptions{}); err != nil {
				complete = false
			}
		}
	}

	return complete
}

/** Builds one service's container, attaches it and starts it. */
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

		return outcome
	}

	outcome.DockerID = id

	if err := e.attachService(ctx, client, id, service, &spec); err != nil {
		outcome.ErrorCode = codeFor(err)

		return outcome
	}

	if err := e.client.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		outcome.ErrorCode = codeFor(classify(err))

		return outcome
	}

	observed, err := e.observe(ctx, id)

	if err != nil {
		outcome.ErrorCode = codeFor(err)

		return outcome
	}

	outcome.State = observed.State

	/*
	 * Running is the bar, not healthy.
	 *
	 * A health check is applied to the container and reported as observed state
	 * afterwards. Waiting for it here would make a deployment's success depend
	 * on a timeout somebody chose in a Compose file, and a slow-starting
	 * database would look like a failed deployment. The same bar the first
	 * deployment of a stack uses, so a redeployment is not judged differently
	 * from the deployment it replaces.
	 */
	if observed.State != "running" {
		outcome.ErrorCode = "CONTAINER_NOT_RUNNING"
	}

	return outcome
}

/*
Attaches a service to its networks under the name its neighbours know it by.

Compose services reach each other by service name, so the container is given
that name as an alias on every network it joins. Without it a stack would only
resolve the container's own name — which is Dockplane's, not the author's, and
not what their configuration refers to.
*/
func (e *Engine) attachService(
	ctx context.Context,
	client StackClient,
	id string,
	service *StackService,
	spec *ContainerSpec,
) error {
	for _, name := range spec.Networks {
		settings := &network.EndpointSettings{Aliases: []string{service.ServiceName}}

		if err := client.NetworkConnect(ctx, name, id, settings); err != nil {
			return fmt.Errorf("%w: network %q: %v", ErrDockerFailedOperation, name, err)
		}
	}

	return nil
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
	return strings.TrimPrefix(name, "/")
}
