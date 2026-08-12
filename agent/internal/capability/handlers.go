package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	"github.com/dockplane/dockplane/agent/internal/compose"
	"github.com/dockplane/dockplane/agent/internal/docker"
	"github.com/dockplane/dockplane/agent/internal/host"
	"github.com/dockplane/dockplane/agent/internal/metrics"
)

// Identifiers accepted from the server.
//
// Docker identifiers and container names are constrained; anything else is
// refused before it reaches the Engine API rather than being passed along in
// the hope that Docker rejects it.
var identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// Sources the registered capabilities read from.
type Sources struct {
	Docker  *docker.Engine
	Host    *host.Collector
	Metrics *metrics.Collector
}

type containerRequest struct {
	ContainerID string `json:"containerId"`
}

type projectRequest struct {
	ProjectName string `json:"projectName"`
}

type listResult struct {
	Containers []docker.ContainerSummary `json:"containers"`
	ObservedAt time.Time                 `json:"observedAt"`
}

type inspectResult struct {
	Container  *docker.ContainerDetail `json:"container"`
	ObservedAt time.Time               `json:"observedAt"`
}

type projectListResult struct {
	Projects   []compose.Project `json:"projects"`
	ObservedAt time.Time         `json:"observedAt"`
}

type projectResult struct {
	Project    *compose.Project `json:"project"`
	ObservedAt time.Time        `json:"observedAt"`
}

/*
Register wires the capability set.

The list is exhaustive and each entry is written out rather than generated, so
adding one is a visible change to this file and to the server catalog that has
to agree with it.

Six read operations and three that change something. Each of the three takes a
container identifier and nothing else — no command, no arguments, no timeout the
caller chooses — so there is no shape in which a request could ask for an
operation the product has not defined.
*/
func Register(registry *Registry, sources Sources) {
	registry.Register(Definition{
		Name:    HostInventory,
		Timeout: 10 * time.Second,
		Handler: func(ctx context.Context, _ json.RawMessage) (any, error) {
			// A host is worth reporting even when Docker is not answering, so
			// the engine version is best-effort rather than a precondition.
			version, err := sources.Docker.Version(ctx)

			if err != nil && !errors.Is(err, docker.ErrUnavailable) {
				return nil, err
			}

			return sources.Host.Inventory(ctx, version), nil
		},
	})

	registry.Register(Definition{
		Name:    HostMetrics,
		Timeout: 10 * time.Second,
		Handler: func(ctx context.Context, _ json.RawMessage) (any, error) {
			return sources.Metrics.Collect(ctx), nil
		},
	})

	registry.Register(Definition{
		Name:    ContainerList,
		Timeout: 20 * time.Second,
		Handler: func(ctx context.Context, _ json.RawMessage) (any, error) {
			containers, err := sources.Docker.ListContainers(ctx)

			if err != nil {
				return nil, wrapDocker(err)
			}

			return listResult{Containers: containers, ObservedAt: time.Now().UTC()}, nil
		},
	})

	registry.Register(Definition{
		Name:    ContainerInspect,
		Timeout: 15 * time.Second,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request containerRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			if !identifierPattern.MatchString(request.ContainerID) {
				return nil, fmt.Errorf("%w: containerId", ErrInvalidPayload)
			}

			detail, err := sources.Docker.InspectContainer(ctx, request.ContainerID)

			if err != nil {
				return nil, wrapDocker(err)
			}

			return inspectResult{Container: detail, ObservedAt: time.Now().UTC()}, nil
		},
	})

	registry.Register(Definition{
		Name:    ComposeList,
		Timeout: 20 * time.Second,
		Handler: func(ctx context.Context, _ json.RawMessage) (any, error) {
			containers, err := sources.Docker.ListContainers(ctx)

			if err != nil {
				return nil, wrapDocker(err)
			}

			return projectListResult{
				Projects:   compose.Group(containers),
				ObservedAt: time.Now().UTC(),
			}, nil
		},
	})

	registerLifecycle(registry, sources)
	registerManagement(registry, sources)
	registerLogs(registry, sources)

	registry.Register(Definition{
		Name:    ComposeInspect,
		Timeout: 20 * time.Second,
		Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
			var request projectRequest

			if err := decode(payload, &request); err != nil {
				return nil, err
			}

			if !identifierPattern.MatchString(request.ProjectName) {
				return nil, fmt.Errorf("%w: projectName", ErrInvalidPayload)
			}

			containers, err := sources.Docker.ListProjectContainers(ctx, request.ProjectName)

			if err != nil {
				return nil, wrapDocker(err)
			}

			project := compose.Find(containers, request.ProjectName)

			if project == nil {
				return nil, fmt.Errorf("%w: no such Compose project", ErrNotFound)
			}

			return projectResult{Project: project, ObservedAt: time.Now().UTC()}, nil
		},
	})
}

/*
registerLifecycle wires the three operations that change a container.

Each validates its identifier before the Engine API sees it, and each reports
what Docker said afterwards rather than what was asked for, so the control
server records an observation instead of an intention.
*/
func registerLifecycle(registry *Registry, sources Sources) {
	lifecycle := []struct {
		name    string
		timeout time.Duration
		run     func(ctx context.Context, id string) (*docker.LifecycleResult, error)
	}{
		{ContainerStart, 60 * time.Second, sources.Docker.Start},
		{ContainerStop, 60 * time.Second, sources.Docker.Stop},
		{ContainerRestart, 90 * time.Second, sources.Docker.Restart},
	}

	for _, operation := range lifecycle {
		run := operation.run

		registry.Register(Definition{
			Name:    operation.name,
			Timeout: operation.timeout,
			Handler: func(ctx context.Context, payload json.RawMessage) (any, error) {
				var request containerRequest

				if err := decode(payload, &request); err != nil {
					return nil, err
				}

				if !identifierPattern.MatchString(request.ContainerID) {
					return nil, fmt.Errorf("%w: containerId", ErrInvalidPayload)
				}

				result, err := run(ctx, request.ContainerID)

				if err != nil {
					return nil, wrapLifecycle(err)
				}

				return result, nil
			},
		})
	}
}

/*
wrapLifecycle translates an engine failure into the agent's vocabulary.

The distinctions that survive are the ones the control server acts on
differently: a container in the wrong state, one that is gone, a daemon that
refused, and everything else.
*/
func wrapLifecycle(err error) error {
	switch {
	case errors.Is(err, docker.ErrAlreadyRunning):
		return fmt.Errorf("%w", ErrAlreadyRunning)
	case errors.Is(err, docker.ErrAlreadyStopped):
		return fmt.Errorf("%w", ErrAlreadyStopped)
	case errors.Is(err, docker.ErrNotFound):
		return fmt.Errorf("%w: no such container", ErrNotFound)
	case errors.Is(err, docker.ErrPermission):
		return fmt.Errorf("%w", ErrDockerPermission)
	case errors.Is(err, docker.ErrUnavailable):
		return fmt.Errorf("%w: %v", ErrDockerUnavailable, err)
	default:
		return fmt.Errorf("%w: %v", ErrDockerFailed, err)
	}
}

// decode reads a request payload, treating an absent one as empty.
/*
decode reads a request payload, refusing anything it does not model.

Unknown fields are an error rather than something to ignore. A request carrying
a field the agent has no concept of — a command, an argument list, input for a
container — is not a request this agent understands, and answering it as though
the extra field were absent would tell the caller it was accepted.
*/
func decode(payload json.RawMessage, target any) error {
	if len(payload) == 0 || string(payload) == "null" {
		return fmt.Errorf("%w: no payload", ErrInvalidPayload)
	}

	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidPayload, err)
	}

	return nil
}

// wrapDocker translates an engine failure into the agent's error vocabulary,
// so the server sees a stable code rather than a client library's wording.
func wrapDocker(err error) error {
	switch {
	case errors.Is(err, docker.ErrUnavailable):
		return fmt.Errorf("%w: %v", ErrDockerUnavailable, err)
	default:
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	}
}
