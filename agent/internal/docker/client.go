// Package docker reads the local Docker Engine.
//
// Everything here goes through the Engine API. The agent never builds a
// `docker` command line: shelling out would turn structured, validated input
// into a string an operator's environment gets to interpret, which is exactly
// the arbitrary-command surface this product refuses to have.
//
// The write surface is three named container operations and nothing else. There
// is no remove, exec, attach, pull or prune, and none is reachable through the
// capability registry.
package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	dockersystem "github.com/docker/docker/api/types/system"
	"github.com/docker/docker/client"
	"github.com/docker/docker/errdefs"
)

// ErrUnavailable reports that the Docker Engine could not be reached or refused
// the agent. Both are operational states to report, never reasons to crash.
var ErrUnavailable = errors.New("the Docker Engine is unavailable")

/*
Client is the subset of the Engine API this agent uses.

Narrow on purpose. Beyond reading, it can start, stop and restart a container by
identifier, and read its log output. There is no create, no remove, no exec and
above all no attach — attach is the API that carries stdin, and its absence here
is what makes it unreachable from anywhere in the agent, whatever a request asks
for.
*/
type Client interface {
	ContainerList(ctx context.Context, options container.ListOptions) ([]container.Summary, error)
	ContainerInspect(ctx context.Context, id string) (container.InspectResponse, error)
	ContainerLogs(ctx context.Context, id string, options container.LogsOptions) (io.ReadCloser, error)
	ContainerStart(ctx context.Context, id string, options container.StartOptions) error
	ContainerStop(ctx context.Context, id string, options container.StopOptions) error
	ContainerRestart(ctx context.Context, id string, options container.StopOptions) error
	Info(ctx context.Context) (dockersystem.Info, error)
	ServerVersion(ctx context.Context) (dockertypes.Version, error)
	Close() error
}

// Engine wraps a Docker client with the error handling the agent relies on.
type Engine struct {
	client Client
}

// Connect opens a client from the environment, which covers the ordinary Linux
// socket at /var/run/docker.sock as well as DOCKER_HOST.
//
// API version negotiation is deliberate: an agent that is newer than the
// daemon it manages must degrade rather than fail outright.
func Connect() (*Engine, error) {
	c, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())

	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}

	return &Engine{client: c}, nil
}

// NewEngine wraps an existing client, used by tests.
func NewEngine(c Client) *Engine {
	return &Engine{client: c}
}

// Close releases the underlying client.
func (e *Engine) Close() error {
	if e == nil || e.client == nil {
		return nil
	}

	return e.client.Close()
}

// Version reports the Docker Engine version, or an empty string when the
// daemon cannot be reached. Host inventory should still be reported without it.
func (e *Engine) Version(ctx context.Context) (string, error) {
	version, err := e.client.ServerVersion(ctx)

	if err != nil {
		return "", classify(err)
	}

	return version.Version, nil
}

// classify turns a Docker client error into something the agent can report
// without leaking connection details into a user-facing message.
func classify(err error) error {
	if err == nil {
		return nil
	}

	/*
	 * Permission is checked before reachability.
	 *
	 * A socket the agent may not open fails as a connection error, so asking
	 * "could you connect" first reports a permission problem as a daemon that
	 * is not running — and sends an operator to restart Docker when what they
	 * need is to add the service account to the docker group.
	 */
	switch {
	case errdefs.IsUnauthorized(err), errdefs.IsForbidden(err), isPermissionDenied(err):
		return fmt.Errorf(
			"%w: the agent is not permitted to use the Docker socket; "+
				"its service account needs membership of the docker group", ErrUnavailable)
	case client.IsErrConnectionFailed(err):
		return fmt.Errorf("%w: the Docker socket could not be reached", ErrUnavailable)
	case errdefs.IsNotFound(err):
		return err
	default:
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
}

/*
isPermissionDenied recognises a socket the agent may not open.

The Docker client reports it as a connection failure with the operating
system's wording buried in the message, and the kernel's EACCES is the same
error whichever way the client wraps it. Both are matched, because the
difference between "Docker is down" and "you may not talk to Docker" is the
difference between two entirely different things for an operator to do.
*/
func isPermissionDenied(err error) bool {
	if errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EACCES) {
		return true
	}

	message := strings.ToLower(err.Error())

	return strings.Contains(message, "permission denied")
}
