package docker

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/docker/docker/api/types/container"
)

/*
Removing the containers of a deployed stack.

The most destructive thing this agent does, and the narrowest. It takes the same
identities every other stack operation takes, proves every one of them before it
touches anything, and removes exactly the containers that carry them.

Two rules are absolute.

Volumes are never removed. Not the stack's own, not an anonymous one, not on any
path through this file. `docker compose down -v` is the operation this product
deliberately does not have: deleting a stack is deleting a configuration and its
containers, and somebody's database is neither.

Nothing is removed until everything is proven. A service whose container is
missing, one held by a container carrying an identity the server did not
allocate, and two containers claiming one service all stop the operation before
the first container is touched — because the alternative is removing half a
stack and then discovering the other half was never ours.
*/

/** What one removal did to the host. */
const (
	// Every expected service is gone.
	RemoveCompleted = "removed"
	// The operation stopped before it removed anything.
	RemoveUnchanged = "failed_before_change"
	// Some services are gone and some are not. Nothing is put back.
	RemovePartial = "partial"
)

/*
StackRemoveResult is what the server learns from one removal.

Names, identities and a code. Never a configuration: a removal reads none, which
is what lets it work on a stack whose Compose source no longer compiles.
*/
type StackRemoveResult struct {
	StackID    string `json:"stackId"`
	RevisionID string `json:"revisionId"`
	Outcome    string `json:"outcome"`
	// The services this call removed, in the order it removed them.
	Removed []StackRemovedService `json:"removed"`
	// Set when the removal did not complete: which service stopped it.
	FailedService string    `json:"failedService,omitempty"`
	ErrorCode     string    `json:"errorCode,omitempty"`
	ObservedAt    time.Time `json:"observedAt"`
}

type StackRemovedService struct {
	ServiceName string `json:"serviceName"`
	ContainerID string `json:"containerId"`
	DockerID    string `json:"dockerId"`
}

/*
StackRemoveIncompleteError says the host was left partly removed.

Carried as an error because the operation did not do what was asked, and with
the result attached because which services are gone is exactly what the server
needs in order to say the stack needs attention rather than that nothing
happened. Nothing is recreated to tidy it up: rebuilding a container here would
mean inventing a configuration this path deliberately never reads.
*/
type StackRemoveIncompleteError struct {
	Result *StackRemoveResult
	Cause  error
}

func (e *StackRemoveIncompleteError) Error() string {
	return fmt.Sprintf("%s: %v", ErrStackRemoveIncomplete, e.Cause)
}

func (e *StackRemoveIncompleteError) Unwrap() error { return ErrStackRemoveIncomplete }

// ErrStackRemoveIncomplete reports a stack that is neither there nor gone.
var ErrStackRemoveIncomplete = errors.New("the stack was left partly removed")

/*
RemoveStack stops and removes every service of a stack.

In reverse dependency order, for the same reason a stop is: whatever depends on
something goes away before the thing it depends on, so nothing is left talking
to a container that has been taken out from under it.

A container is stopped before it is removed rather than removed by force. Force
is what Docker does when a process will not exit in time, not the first thing to
try on a database.
*/
func (e *Engine) RemoveStack(ctx context.Context, plan *StackLifecyclePlan) (*StackRemoveResult, error) {
	if err := plan.Validate(); err != nil {
		return nil, err
	}

	order, err := plan.startOrder()

	if err != nil {
		return nil, err
	}

	/*
	 * The wider client, which is the only one that can remove a container.
	 * The base interface deliberately cannot: a build that never widens it has
	 * no path to removing anything at all.
	 */
	client, err := e.management()

	if err != nil {
		return nil, err
	}

	// Every service, proven, before the first one is touched.
	resolved, err := e.resolveStackServices(ctx, plan)

	if err != nil {
		return nil, err
	}

	identities := map[string]string{}

	for _, service := range plan.Services {
		identities[service.ServiceName] = service.ContainerID
	}

	result := &StackRemoveResult{
		StackID:    plan.StackID,
		RevisionID: plan.RevisionID,
		Outcome:    RemoveCompleted,
		ObservedAt: time.Now().UTC(),
	}

	seconds := int(StopTimeout.Seconds())

	for _, name := range reversed(order) {
		service := resolved[name]

		if service.running {
			if err := e.client.ContainerStop(ctx, service.dockerID, container.StopOptions{Timeout: &seconds}); err != nil {
				return nil, e.removeFailed(result, name, lifecycleError(err))
			}

			service.running = false
		}

		/*
		 * RemoveVolumes stays false on every path.
		 *
		 * It is the difference between removing a stack and removing somebody's
		 * data, and it is not a decision this product gives anybody a way to
		 * make by accident.
		 */
		if err := client.ContainerRemove(ctx, service.dockerID, container.RemoveOptions{RemoveVolumes: false}); err != nil {
			return nil, e.removeFailed(result, name, lifecycleError(err))
		}

		result.Removed = append(result.Removed, StackRemovedService{
			ServiceName: name,
			ContainerID: identities[name],
			DockerID:    service.dockerID,
		})
	}

	result.ObservedAt = time.Now().UTC()

	return result, nil
}

/*
What is reported when a removal stopped partway.

Nothing is recreated and nothing else is removed. The server reads the host and
decides what the stack now is; a stack that is half gone is a fact somebody has
to look at, not something to tidy away.
*/
func (e *Engine) removeFailed(result *StackRemoveResult, service string, cause error) error {
	result.FailedService = service
	result.ErrorCode = lifecycleCode(cause)
	result.ObservedAt = time.Now().UTC()

	if len(result.Removed) == 0 {
		result.Outcome = RemoveUnchanged

		return fmt.Errorf("%s: %w", service, cause)
	}

	result.Outcome = RemovePartial

	return &StackRemoveIncompleteError{Result: result, Cause: cause}
}
