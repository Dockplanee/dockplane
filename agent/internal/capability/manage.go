package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
The capabilities that build a container.

Each carries a typed specification and a target the server resolved, never a
Docker API payload and never an identifier the browser chose. The decoder
refuses a field it does not model, so a request carrying an option Dockplane has
not defined — a privileged flag, a device, a capability set — is not answered as
though the extra field were absent.

The specification is validated here as well as on the server. The server's check
is what tells an operator they made a mistake; this one is what the host is
defended by, and it runs whether or not the server did its job.
*/

// createRequest asks for a container that does not exist yet.
type createRequest struct {
	Spec docker.ContainerSpec `json:"spec"`
	// The identity the control server allocated for this container, applied as
	// a label so the container can still be recognised after Docker replaces
	// its identifier. The browser never chooses it.
	ContainerID string `json:"containerId,omitempty"`
	// The configuration this container will represent, so a crash mid-operation
	// can be resolved by reading a label rather than by guessing.
	DesiredConfigID string `json:"desiredConfigId,omitempty"`
	// Set when the container belongs to a stack, so the agent can label it as
	// such. A caller cannot put this in the spec's own labels: the agent applies
	// its labels last.
	Stack string `json:"stack,omitempty"`
}

// replaceRequest asks for an existing container to be rebuilt.
//
// The whole desired configuration, not a patch. The server reads the current
// container, applies what the operator changed and sends the result, so there
// is no merge happening on a host and no way for two partial updates to
// interleave into a configuration nobody asked for.
type replaceRequest struct {
	// The Docker container being replaced, resolved by the server.
	DockerID string `json:"dockerId"`
	// The Dockplane identity that survives the replacement.
	ContainerID string `json:"containerId,omitempty"`
	// The candidate configuration. The replacement carries it from the moment it
	// is built, so a rollback leaves the original still carrying the old one.
	DesiredConfigID string               `json:"desiredConfigId,omitempty"`
	Spec            docker.ContainerSpec `json:"spec"`
	Stack           string               `json:"stack,omitempty"`
}

// removeRequest asks for a container to be taken away. Volumes are not
// mentioned because they are never removed with it.
type removeRequest struct {
	// The Docker container, resolved by the server from the Dockplane resource.
	DockerID string `json:"dockerId"`
	// Stop it first if it is running. Absent, a running container is refused
	// rather than killed.
	StopFirst bool `json:"stopFirst,omitempty"`
}

func registerManagement(registry *Registry, sources Sources) {
	registry.Register(Definition{
		Name:    ContainerCreate,
		Timeout: 5 * time.Minute,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request createRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			result, err := sources.Docker.Create(
				ctx,
				&request.Spec,
				request.Stack,
				request.ContainerID,
				request.DesiredConfigID,
			)

			if err != nil {
				return nil, wrapManagement(err)
			}

			return result, nil
		},
	})

	registry.Register(Definition{
		Name:    ContainerReplace,
		Timeout: 7 * time.Minute,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request replaceRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			if !identifierPattern.MatchString(request.DockerID) {
				return nil, fmt.Errorf("%w: dockerId", ErrInvalidPayload)
			}

			result, err := sources.Docker.Replace(
				ctx,
				request.DockerID,
				&request.Spec,
				request.Stack,
				request.ContainerID,
				request.DesiredConfigID,
			)

			if err != nil {
				// A rollback is still a result: the server needs to know the
				// original was put back rather than only that this failed.
				if result != nil {
					return result, wrapManagement(err)
				}

				return nil, wrapManagement(err)
			}

			return result, nil
		},
	})

	registry.Register(Definition{
		Name:    ContainerRemove,
		Timeout: 90 * time.Second,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request removeRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			if !identifierPattern.MatchString(request.DockerID) {
				return nil, fmt.Errorf("%w: dockerId", ErrInvalidPayload)
			}

			/*
			 * A running container is stopped before it is removed, and only
			 * when the request said so.
			 *
			 * Docker's force removal kills the process outright. A container
			 * with data to flush deserves the same graceful stop every other
			 * lifecycle operation gives it, so removal asks for one rather than
			 * reaching for the kill.
			 */
			if request.StopFirst {
				if _, err := sources.Docker.Stop(ctx, request.DockerID); err != nil {
					if !errors.Is(err, docker.ErrAlreadyStopped) {
						return nil, wrapManagement(err)
					}
				}
			}

			result, err := sources.Docker.Remove(ctx, request.DockerID, false)

			if err != nil {
				return nil, wrapManagement(err)
			}

			return result, nil
		},
	})
}

/*
wrapManagement translates an engine failure into the agent's vocabulary.

The distinctions that survive are the ones the control server tells an operator
about differently: a name already taken, an image that is not there, a
specification the host refused, and a replacement that did not come up.
*/
func wrapManagement(err error) error {
	switch {
	case errors.Is(err, docker.ErrInvalidSpec):
		return fmt.Errorf("%w: %v", ErrInvalidSpec, err)
	case errors.Is(err, docker.ErrNameInUse):
		return fmt.Errorf("%w", ErrNameInUse)
	case errors.Is(err, docker.ErrImageNotFound):
		return fmt.Errorf("%w", ErrImageNotFound)
	case errors.Is(err, docker.ErrReplaceFailed):
		return fmt.Errorf("%w: %v", ErrReplacementFailed, err)
	default:
		return wrapLifecycle(err)
	}
}
