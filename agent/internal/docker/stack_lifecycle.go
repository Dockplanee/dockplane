package docker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
)

/*
Starting, stopping and restarting a stack that is already deployed.

Nothing here creates, recreates or removes anything. A lifecycle operation moves
containers that already exist between running and stopped, which is why it needs
no plan, no Compose file and no environment: the control server names the stack,
the revision it believes is deployed and the services it expects, and the agent
finds those containers on the host by the identity Dockplane gave them.

The order is the product's, not Docker's. Services come up after what they
depend on and go down before it, so a database is not taken away from something
still writing to it. A restart is a stop pass followed by a start pass for the
same reason: restarting every container at once would have web talking to a
database that is on its way down.

Fail closed everywhere. A service whose container is missing, one held by a
container carrying somebody else's identity, and two containers claiming one
service are all refusals rather than something to work around. Guessing by name
is what would let this stop a container that is not ours.
*/

// StackLifecyclePlanVersion is the request shape this agent understands.
const StackLifecyclePlanVersion = 1

// The three operations, named so a result says which one produced it.
const (
	StackOperationStart   = "start"
	StackOperationStop    = "stop"
	StackOperationRestart = "restart"
)

/*
StackLifecyclePlan is what the control server sends.

Identities rather than Docker identifiers: the container this names is whichever
one on the host carries that identity now. A Docker identifier from the server
would be a value the host could have moved on from, and acting on it would mean
operating on the strength of something remembered instead of something observed.
*/
type StackLifecyclePlan struct {
	PlanVersion int    `json:"planVersion"`
	StackID     string `json:"stackId"`
	// The revision the server has confirmed is deployed. A container claiming a
	// service of this stack under a different revision means the two sides
	// disagree about what is running, which no lifecycle operation may paper over.
	RevisionID string                  `json:"revisionId"`
	Services   []StackLifecycleService `json:"services"`
}

// StackLifecycleService is one expected service and what it waits for.
type StackLifecycleService struct {
	ServiceName string `json:"serviceName"`
	// The Dockplane container resource, which is what proves the container on
	// the host is the one the server means.
	ContainerID string   `json:"containerId"`
	DependsOn   []string `json:"dependsOn,omitempty"`
}

/** What one lifecycle operation did. */
const (
	// Every expected service reached the state the operation is for.
	LifecycleCompleted = "completed"
	// Some did and some did not. The host is neither where it was nor where it
	// was going, and nothing is undone to tidy that up.
	LifecyclePartial = "partial"
	// The operation stopped before it changed anything.
	LifecycleUnchanged = "failed_before_change"
)

/*
StackLifecycleResult is what the server learns from one operation.

Names, identifiers, states and times. No configuration, no environment and
nothing from a Compose file — a lifecycle operation reads none of those, which
is the point of it being a separate path.
*/
type StackLifecycleResult struct {
	StackID    string `json:"stackId"`
	RevisionID string `json:"revisionId"`
	Operation  string `json:"operation"`
	// One of the three above. The server reads the host afterwards regardless;
	// this is what the agent believes it did.
	Outcome  string                `json:"outcome"`
	Services []StackServiceRuntime `json:"services"`
	// Set when the operation did not complete: which service stopped it.
	FailedService string    `json:"failedService,omitempty"`
	ErrorCode     string    `json:"errorCode,omitempty"`
	ObservedAt    time.Time `json:"observedAt"`
}

/*
StackServiceRuntime is one service as Docker describes it afterwards.

`StartedAt` is Docker's own, reported because it is the only thing that
distinguishes a container that was just restarted from the same container left
alone: a restart keeps the identifier and changes nothing else observable.
*/
type StackServiceRuntime struct {
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId"`
	DockerID    string `json:"dockerId"`
	State       string `json:"state"`
	StartedAt   string `json:"startedAt,omitempty"`
}

var (
	// A service the server expects has no container on this host. Starting one
	// would mean creating it, and creating belongs to deploying.
	ErrStackServiceMissing = errors.New("a service of this stack is not on the host")
	// Some services were changed and others were not.
	ErrStackLifecycleIncomplete = errors.New("the stack was left partly changed")
)

// Validate checks a lifecycle request before the host is touched.
func (p *StackLifecyclePlan) Validate() error {
	if p.PlanVersion != StackLifecyclePlanVersion {
		return fmt.Errorf("%w: %d", ErrStackPlanUnsupported, p.PlanVersion)
	}

	if p.StackID == "" || p.RevisionID == "" {
		return fmt.Errorf("%w: an operation names the stack and revision it is for", ErrStackPlanInvalid)
	}

	if len(p.Services) == 0 {
		return fmt.Errorf("%w: an operation names the services it is for", ErrStackPlanInvalid)
	}

	seen := map[string]bool{}
	identities := map[string]bool{}

	for _, service := range p.Services {
		if service.ServiceName == "" {
			return fmt.Errorf("%w: a service has no name", ErrStackPlanInvalid)
		}

		if seen[service.ServiceName] {
			return fmt.Errorf("%w: %s is listed twice", ErrStackPlanInvalid, service.ServiceName)
		}

		seen[service.ServiceName] = true

		if service.ContainerID == "" {
			return fmt.Errorf(
				"%w: %s has no Dockplane container identity",
				ErrStackPlanInvalid,
				service.ServiceName,
			)
		}

		if identities[service.ContainerID] {
			return fmt.Errorf("%w: two services claim the same Dockplane container", ErrStackPlanInvalid)
		}

		identities[service.ContainerID] = true
	}

	for _, service := range p.Services {
		for _, dependency := range service.DependsOn {
			if !seen[dependency] {
				return fmt.Errorf(
					"%w: %s depends on %s, which the operation does not cover",
					ErrStackPlanInvalid,
					service.ServiceName,
					dependency,
				)
			}
		}
	}

	_, err := p.startOrder()

	return err
}

// startOrder is the order services may be started in: dependencies first.
func (p *StackLifecyclePlan) startOrder() ([]string, error) {
	dependencies := map[string][]string{}

	for _, service := range p.Services {
		dependencies[service.ServiceName] = append([]string{}, service.DependsOn...)
	}

	return orderByDependencies(dependencies)
}

/*
StartStack starts every expected service, dependencies first.

A service already running is left alone rather than reported as a failure: the
operation is for the stack, and a stack with one container up is a stack an
operator asked to be running.
*/
func (e *Engine) StartStack(ctx context.Context, plan *StackLifecyclePlan) (*StackLifecycleResult, error) {
	return e.runLifecycle(ctx, plan, StackOperationStart)
}

// StopStack stops every expected service in reverse dependency order.
func (e *Engine) StopStack(ctx context.Context, plan *StackLifecyclePlan) (*StackLifecycleResult, error) {
	return e.runLifecycle(ctx, plan, StackOperationStop)
}

/*
RestartStack takes the stack down and brings it back up.

Deliberately not a Docker restart per container. Restarting each on its own
would have every service down at a different moment and dependencies talking to
something that is going away; a stop pass followed by a start pass is the same
sequence a stop and a start would produce, which is what makes a restart
predictable.

The containers are the same containers throughout. Nothing is recreated, so the
Docker identifiers, the revision they carry and the volumes they hold are
exactly what they were.
*/
func (e *Engine) RestartStack(ctx context.Context, plan *StackLifecyclePlan) (*StackLifecycleResult, error) {
	return e.runLifecycle(ctx, plan, StackOperationRestart)
}

func (e *Engine) runLifecycle(
	ctx context.Context,
	plan *StackLifecyclePlan,
	operation string,
) (*StackLifecycleResult, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}

	order, err := plan.startOrder()

	if err != nil {
		return nil, err
	}

	resolved, err := e.resolveStackServices(ctx, plan)

	if err != nil {
		return nil, err
	}

	changed := false

	// Down first for a restart, so nothing is started while what it depends on
	// is still on its way out.
	if operation == StackOperationStop || operation == StackOperationRestart {
		if err := e.stopServices(ctx, reversed(order), resolved, &changed); err != nil {
			return nil, e.incomplete(ctx, plan, operation, resolved, changed, err)
		}
	}

	if operation == StackOperationStart || operation == StackOperationRestart {
		if err := e.startServices(ctx, order, resolved, &changed); err != nil {
			return nil, e.incomplete(ctx, plan, operation, resolved, changed, err)
		}
	}

	return e.lifecycleResult(ctx, plan, operation, resolved, LifecycleCompleted, "", nil), nil
}

// stopServices stops what is running, in the order it is given.
func (e *Engine) stopServices(
	ctx context.Context,
	order []string,
	resolved map[string]*resolvedService,
	changed *bool,
) error {
	seconds := int(StopTimeout.Seconds())

	for _, name := range order {
		service := resolved[name]

		if !service.running {
			continue
		}

		if err := e.client.ContainerStop(ctx, service.dockerID, container.StopOptions{Timeout: &seconds}); err != nil {
			return &lifecycleFailure{service: name, err: lifecycleError(err)}
		}

		service.running = false
		*changed = true
	}

	return nil
}

// startServices starts what is not running, in the order it is given.
func (e *Engine) startServices(
	ctx context.Context,
	order []string,
	resolved map[string]*resolvedService,
	changed *bool,
) error {
	for _, name := range order {
		service := resolved[name]

		if service.running {
			continue
		}

		if err := e.client.ContainerStart(ctx, service.dockerID, container.StartOptions{}); err != nil {
			return &lifecycleFailure{service: name, err: lifecycleError(err)}
		}

		service.running = true
		*changed = true
	}

	return nil
}

/*
What is reported when an operation stopped partway.

Nothing is undone. A stack that is half stopped is a fact about the host, and
starting services again to make the result look tidy would be a mutation nobody
asked for — on top of which it could fail too. The server reads the host and
decides what the stack now is.
*/
func (e *Engine) incomplete(
	ctx context.Context,
	plan *StackLifecyclePlan,
	operation string,
	resolved map[string]*resolvedService,
	changed bool,
	err error,
) error {
	var failure *lifecycleFailure

	service := ""

	if errors.As(err, &failure) {
		service = failure.service
		err = failure.err
	}

	if !changed {
		return fmt.Errorf("%s: %w", service, err)
	}

	result := e.lifecycleResult(ctx, plan, operation, resolved, LifecyclePartial, service, err)

	return &StackLifecycleIncompleteError{Result: result, Cause: err}
}

/*
StackLifecycleIncompleteError says the host was left partly changed.

Carried as an error because the operation did not do what was asked, and with
the result attached because what it did do is exactly what the server needs in
order to say the stack needs attention rather than that nothing happened.
*/
type StackLifecycleIncompleteError struct {
	Result *StackLifecycleResult
	Cause  error
}

func (e *StackLifecycleIncompleteError) Error() string {
	return fmt.Sprintf("%s: %v", ErrStackLifecycleIncomplete, e.Cause)
}

func (e *StackLifecycleIncompleteError) Unwrap() error { return ErrStackLifecycleIncomplete }

// lifecycleFailure names the service an operation stopped on.
type lifecycleFailure struct {
	service string
	err     error
}

func (f *lifecycleFailure) Error() string { return fmt.Sprintf("%s: %v", f.service, f.err) }

func (f *lifecycleFailure) Unwrap() error { return f.err }

// lifecycleResult reads every service back off the host and reports it.
func (e *Engine) lifecycleResult(
	ctx context.Context,
	plan *StackLifecyclePlan,
	operation string,
	resolved map[string]*resolvedService,
	outcome string,
	failedService string,
	cause error,
) *StackLifecycleResult {
	result := &StackLifecycleResult{
		StackID:       plan.StackID,
		RevisionID:    plan.RevisionID,
		Operation:     operation,
		Outcome:       outcome,
		FailedService: failedService,
		ObservedAt:    time.Now().UTC(),
	}

	if cause != nil {
		result.ErrorCode = lifecycleCode(cause)
	}

	for _, service := range plan.Services {
		found := resolved[service.ServiceName]

		if found == nil {
			continue
		}

		runtime := StackServiceRuntime{
			ServiceName: service.ServiceName,
			ContainerID: service.ContainerID,
			DockerID:    found.dockerID,
			State:       "unknown",
		}

		if inspected, err := e.client.ContainerInspect(ctx, found.dockerID); err == nil && inspected.State != nil {
			runtime.State = inspected.State.Status
			runtime.StartedAt = inspected.State.StartedAt
		}

		result.Services = append(result.Services, runtime)
	}

	return result
}

// A service of the stack as it is on the host right now.
type resolvedService struct {
	dockerID string
	running  bool
}

/*
Finds the container behind every expected service, and refuses anything unclear.

Ownership is proven from the labels Dockplane wrote: managed, the stack, the
service, the revision the server says is deployed, and the container identity it
allocated. A container that matches by name and not by identity is somebody
else's, and this operation would stop it.
*/
func (e *Engine) resolveStackServices(
	ctx context.Context,
	plan *StackLifecyclePlan,
) (map[string]*resolvedService, error) {
	listed, err := e.client.ContainerList(ctx, container.ListOptions{All: true})

	if err != nil {
		return nil, classify(err)
	}

	expected := map[string]string{}

	for _, service := range plan.Services {
		expected[service.ServiceName] = service.ContainerID
	}

	resolved := map[string]*resolvedService{}

	for _, summary := range listed {
		if summary.Labels[LabelManaged] != "true" || summary.Labels[LabelStackID] != plan.StackID {
			continue
		}

		service := summary.Labels[LabelStackService]
		identity, wanted := expected[service]

		if !wanted {
			/*
			 * A container of this stack whose service the server does not expect.
			 * It is not touched — no lifecycle operation removes or adopts
			 * anything — but it does mean the host holds more of this stack than
			 * the server believes, so nothing is concluded from a partial picture.
			 */
			return nil, fmt.Errorf(
				"%w: a container of this stack is service %q, which this operation does not cover",
				ErrStackStateAmbiguous,
				service,
			)
		}

		if summary.Labels[LabelContainerID] != identity {
			return nil, fmt.Errorf(
				"%w: service %s is held by a container with another identity",
				ErrStackStateAmbiguous,
				service,
			)
		}

		if summary.Labels[LabelStackRevisionID] != plan.RevisionID {
			return nil, fmt.Errorf(
				"%w: service %s is running a revision this operation is not for",
				ErrStackStateAmbiguous,
				service,
			)
		}

		if _, already := resolved[service]; already {
			return nil, fmt.Errorf(
				"%w: more than one container is service %s",
				ErrStackStateAmbiguous,
				service,
			)
		}

		inspected, err := e.client.ContainerInspect(ctx, summary.ID)

		if err != nil {
			return nil, classify(err)
		}

		resolved[service] = &resolvedService{
			dockerID: summary.ID,
			running:  inspected.State != nil && inspected.State.Running,
		}
	}

	for _, service := range plan.Services {
		if _, found := resolved[service.ServiceName]; !found {
			return nil, fmt.Errorf("%w: %s", ErrStackServiceMissing, service.ServiceName)
		}
	}

	return resolved, nil
}

// reversed is stop order: the opposite of the order things are started in.
func reversed(order []string) []string {
	out := make([]string, len(order))

	for index, name := range order {
		out[len(order)-1-index] = name
	}

	return out
}

// lifecycleCode names a failure without quoting anything from the host.
func lifecycleCode(err error) string {
	switch {
	case errors.Is(err, ErrNotFound):
		return "CONTAINER_NOT_FOUND"
	case errors.Is(err, ErrPermission):
		return "DOCKER_PERMISSION_DENIED"
	default:
		return "DOCKER_OPERATION_FAILED"
	}
}
