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
Applying a revision of a stack.

The payload is a plan the control server produced from a Compose file it read
and validated. This side has no Compose parser and no YAML: what may be asked
for is the shape of the plan type, and a field nobody modelled cannot be
requested however a Compose file was written.

One capability covers a stack that has never run, one moving to another revision
and one being converged after a deployment that stopped halfway. They are the
same operation — put this revision on the host — and differ only in what is
already there, which the agent reads rather than being told.

The plan is validated again here. The server checked it too; this is the copy
that runs on the machine, and it is the one that matters when the server is
wrong.
*/
type stackDeployRequest struct {
	Plan docker.StackPlan `json:"plan"`
}

func registerStack(registry *Registry, sources Sources) {
	registry.Register(Definition{
		Name: StackDeploy,
		// Long, because it pulls images. Bounded, because nothing may run
		// without an end.
		Timeout: 15 * time.Minute,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request stackDeployRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			result, err := sources.Docker.ApplyStack(ctx, &request.Plan)

			if err != nil {
				return nil, wrapStack(err)
			}

			return result, nil
		},
	})
}

/*
Maps a refusal to a code the server already understands.

A plan this build cannot read and a plan that describes something impossible are
different things, and an operator is told which. Nothing here quotes the plan:
it carries the values of somebody's environment.
*/
func wrapStack(err error) error {
	switch {
	case errors.Is(err, docker.ErrStackPlanUnsupported):
		return fmt.Errorf("%w: %v", ErrUnsupported, err)
	case errors.Is(err, docker.ErrStackPlanInvalid):
		return fmt.Errorf("%w: %v", ErrInvalidPayload, err)
	case errors.Is(err, docker.ErrStackResourceConflict):
		return fmt.Errorf("%w: %v", ErrStackConflict, err)
	case errors.Is(err, docker.ErrStackStateAmbiguous):
		return fmt.Errorf("%w: %v", ErrStackAmbiguous, err)
	case errors.Is(err, docker.ErrStackVolumeMissing):
		return fmt.Errorf("%w: %v", ErrVolumeMissing, err)
	default:
		return err
	}
}
