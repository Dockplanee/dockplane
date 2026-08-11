package docker

import (
	"context"
	"errors"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/errdefs"
)

/*
Container lifecycle.

The first operations in this agent that change anything. They are deliberately
narrow: three named actions on one container, each taking an identifier the
control server already knew and nothing else. There is no command, no argument
list and no way to express an operation the product has not defined.

Everything goes through the Engine API. Building a `docker` command line would
turn a validated identifier back into a string an operator's shell gets to
interpret, which is the arbitrary-command surface this product refuses to have.
*/

// Errors the control server distinguishes.
var (
	ErrAlreadyRunning = errors.New("the container is already running")
	ErrAlreadyStopped = errors.New("the container is not running")
	ErrNotFound       = errors.New("no such container")
	ErrPermission     = errors.New("the Docker daemon refused the operation")
)

/*
StopTimeout bounds how long Docker waits for a container to exit on its own
before killing it.

Fixed here rather than accepted from a request. A caller able to choose it could
ask for a stop that waits an hour, holding a request open and a container in a
half-stopped state for as long as it liked.
*/
const StopTimeout = 30 * time.Second

// LifecycleResult reports what the operation did.
type LifecycleResult struct {
	DockerID string `json:"dockerId"`
	/** The state Docker reported once the operation returned. */
	State      string    `json:"state"`
	Health     string    `json:"health"`
	StartedAt  string    `json:"startedAt,omitempty"`
	ObservedAt time.Time `json:"observedAt"`
}

/*
Start starts a container.

A container that is already running is an error rather than a silent success.
Reporting "started" for something this call did not start would make the audit
trail say one thing and the host another; the control server turns it into a
state the operator can read.
*/
func (e *Engine) Start(ctx context.Context, id string) (*LifecycleResult, error) {
	inspected, err := e.client.ContainerInspect(ctx, id)

	if err != nil {
		return nil, lifecycleError(err)
	}

	if inspected.State != nil && inspected.State.Running {
		return nil, ErrAlreadyRunning
	}

	if err := e.client.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		return nil, lifecycleError(err)
	}

	return e.observe(ctx, id)
}

/*
Stop stops a container.

A container that is already stopped is an error for the same reason a start of a
running one is: the operation did not do what the record would claim.
*/
func (e *Engine) Stop(ctx context.Context, id string) (*LifecycleResult, error) {
	inspected, err := e.client.ContainerInspect(ctx, id)

	if err != nil {
		return nil, lifecycleError(err)
	}

	if inspected.State == nil || !inspected.State.Running {
		return nil, ErrAlreadyStopped
	}

	seconds := int(StopTimeout.Seconds())

	if err := e.client.ContainerStop(ctx, id, container.StopOptions{Timeout: &seconds}); err != nil {
		return nil, lifecycleError(err)
	}

	return e.observe(ctx, id)
}

/*
Restart restarts a container.

One Docker call rather than a stop followed by a start. Sequencing it here would
create a window in which the container is down and no operation is recorded as
running, and a failure halfway would leave the audit trail describing a restart
that actually stopped something.
*/
func (e *Engine) Restart(ctx context.Context, id string) (*LifecycleResult, error) {
	if _, err := e.client.ContainerInspect(ctx, id); err != nil {
		return nil, lifecycleError(err)
	}

	seconds := int(StopTimeout.Seconds())

	if err := e.client.ContainerRestart(ctx, id, container.StopOptions{Timeout: &seconds}); err != nil {
		return nil, lifecycleError(err)
	}

	return e.observe(ctx, id)
}

// observe reports what Docker says about the container once the call returned.
func (e *Engine) observe(ctx context.Context, id string) (*LifecycleResult, error) {
	inspected, err := e.client.ContainerInspect(ctx, id)

	if err != nil {
		return nil, lifecycleError(err)
	}

	result := &LifecycleResult{DockerID: inspected.ID, State: "unknown", Health: "none", ObservedAt: time.Now().UTC()}

	if inspected.State != nil {
		result.State = inspected.State.Status
		result.StartedAt = inspected.State.StartedAt

		if inspected.State.Health != nil && inspected.State.Health.Status != "" {
			result.Health = inspected.State.Health.Status
		}
	}

	return result, nil
}

// lifecycleError separates the answers the control server acts on differently.
func lifecycleError(err error) error {
	switch {
	case err == nil:
		return nil
	case errdefs.IsNotFound(err):
		return ErrNotFound
	case errdefs.IsForbidden(err), errdefs.IsUnauthorized(err), isPermissionDenied(err):
		return ErrPermission
	default:
		return classify(err)
	}
}
