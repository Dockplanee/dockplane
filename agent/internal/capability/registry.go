// Package capability defines what the agent is able to do.
//
// A capability is a named operation with a schema, a timeout and a handler. The
// registry is the only way to reach one, so an operation that is not registered
// cannot be invoked no matter what the server asks for.
package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

// Capability names. This list is exhaustive and matches the server catalog.
const (
	HostInventory    = "host.inventory"
	HostMetrics      = "host.metrics"
	ContainerList    = "container.list"
	ContainerInspect = "container.inspect"
	ComposeList      = "compose.list"
	ComposeInspect   = "compose.inspect"

	/*
	 * The operations that change something.
	 *
	 * Three named actions, each on one container. There is deliberately no
	 * generic command capability: an agent that accepted an operation name plus
	 * arguments would be a remote shell with extra steps, and nothing about the
	 * transport would stop it being used as one.
	 */
	ContainerStart   = "container.start"
	ContainerStop    = "container.stop"
	ContainerRestart = "container.restart"

	/*
	 * The operations that build one.
	 *
	 * Each carries a typed container specification, never a Docker API payload.
	 * What may be asked for is the shape of that type: an option Docker has and
	 * Dockplane has not modelled cannot be requested, whatever a caller sends.
	 */
	ContainerCreate  = "container.create"
	ContainerReplace = "container.replace"
	ContainerRemove  = "container.remove"

	/*
	 * A whole stack, as a plan somebody else resolved.
	 *
	 * The agent has no Compose parser and never sees a Compose file: the control
	 * server reads one and sends a typed plan, so what may be deployed is the
	 * shape of that type. There is no compose command, no docker compose CLI and
	 * nothing that takes a string to run.
	 */
	StackDeploy = "stack.deploy"

	/*
	 * A deployed stack, moved between running and stopped.
	 *
	 * Three named operations rather than one that takes the word to perform,
	 * for the same reason the container operations are three: a capability with
	 * a command in its payload is a shell with a schema in front of it. None of
	 * these creates, recreates or removes anything.
	 */
	StackStart   = "stack.start"
	StackStop    = "stack.stop"
	StackRestart = "stack.restart"

	/*
	 * The containers of a stack, taken away.
	 *
	 * It removes containers and nothing else: no volume, on any path. Deleting
	 * a stack is deleting a configuration and the things running it, and
	 * somebody's database is neither — which is why there is no field here in
	 * which a caller could ask for one.
	 */
	StackRemove = "stack.remove"

	/*
	 * The one capability that answers over time rather than once.
	 *
	 * It reads a container's output and nothing else. There is no attach, which
	 * is the Docker API that would carry input, and no field in which a caller
	 * could put any: the payload is a container identifier and a fixed set of
	 * log options.
	 */
	ContainerLogs = "container.logs"
)

// Errors a handler may return that map to a stable code on the wire.
var (
	ErrUnsupported       = errors.New("capability not supported")
	ErrInvalidPayload    = errors.New("invalid payload")
	ErrDockerUnavailable = errors.New("docker unavailable")
	ErrNotFound          = errors.New("not found")
	ErrAlreadyRunning    = errors.New("container already running")
	ErrAlreadyStopped    = errors.New("container already stopped")
	ErrNameInUse         = errors.New("container name in use")
	ErrInvalidSpec       = errors.New("invalid container specification")
	ErrImageNotFound     = errors.New("image not found")
	ErrReplacementFailed = errors.New("replacement failed")
	// Something on the host has a name this stack needs and is not this
	// stack's. Distinct from a container name collision, because the thing in
	// the way may be a volume holding somebody's data.
	ErrStackConflict = errors.New("a resource of that name belongs to something else")
	// The host does not say clearly enough what the stack currently is: two
	// containers claim one service, or one claims an identity nobody gave it.
	ErrStackAmbiguous = errors.New("the stack's containers on this host are ambiguous")
	// A volume the running stack mounts is gone. Never replaced with an empty
	// one of the same name.
	ErrVolumeMissing = errors.New("a volume this stack uses does not exist")
	// A service the server expects has no container on the host. Never answered
	// by creating one: creating belongs to deploying a revision.
	ErrStackServiceMissing = errors.New("a service of this stack is not on the host")
	// Some services moved and others did not. The host is left as it is.
	ErrStackLifecycleIncomplete = errors.New("the stack was left partly changed")
	// Some of a stack's containers are gone and some are not. Nothing is
	// rebuilt: this path never reads the configuration one would need.
	ErrStackRemoveIncomplete = errors.New("the stack was left partly removed")
	ErrDockerPermission      = errors.New("docker permission denied")
	ErrDockerFailed          = errors.New("docker operation failed")
)

// Handler performs a capability. The context carries the per-capability
// timeout, so a handler that hangs is abandoned rather than blocking the agent.
type Handler func(ctx context.Context, payload json.RawMessage) (any, error)

// Definition is one registered capability.
type Definition struct {
	Name    string
	Timeout time.Duration
	Handler Handler
}

// Chunk is one delivery of a streaming capability.
type Chunk struct {
	Payload any
	// Dropped counts what was discarded because the consumer was behind. It is
	// carried with the data rather than logged, so the loss reaches the viewer.
	Dropped int
}

/*
StreamHandler performs a capability that answers over time.

It emits chunks until the work finishes or the context ends. Emit returns an
error when the consumer has gone, which the handler must treat as a reason to
stop rather than something to retry: a stream nobody is reading has no reason to
keep a Docker reader open.
*/
type StreamHandler func(
	ctx context.Context,
	payload json.RawMessage,
	emit func(Chunk) error,
) error

/*
StreamDefinition is one registered streaming capability.

MaxDuration is the agent's own ceiling. The control server decides how long a
stream should live and cancels it; this is what stops a stream the server forgot
about from running for the life of the process.
*/
type StreamDefinition struct {
	Name        string
	MaxDuration time.Duration
	Handler     StreamHandler
}

// Registry holds the capabilities this agent offers.
type Registry struct {
	definitions map[string]Definition
	streams     map[string]StreamDefinition
}

// New builds an empty registry.
func New() *Registry {
	return &Registry{
		definitions: make(map[string]Definition),
		streams:     make(map[string]StreamDefinition),
	}
}

// Register adds a capability. A duplicate name is a programming error and
// panics at startup rather than silently replacing a handler.
func (r *Registry) Register(definition Definition) {
	r.reserve(definition.Name)
	r.definitions[definition.Name] = definition
}

// RegisterStream adds a capability that answers over time.
func (r *Registry) RegisterStream(definition StreamDefinition) {
	r.reserve(definition.Name)
	r.streams[definition.Name] = definition
}

func (r *Registry) reserve(name string) {
	_, single := r.definitions[name]
	_, streaming := r.streams[name]

	if single || streaming {
		panic(fmt.Sprintf("capability registered twice: %s", name))
	}
}

// IsStream reports whether a name answers over time rather than once.
func (r *Registry) IsStream(name string) bool {
	_, exists := r.streams[name]

	return exists
}

// Names lists the registered capabilities in a stable order. This is what the
// agent advertises; it never advertises something it cannot perform.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.definitions)+len(r.streams))

	for name := range r.definitions {
		names = append(names, name)
	}

	for name := range r.streams {
		names = append(names, name)
	}

	sort.Strings(names)

	return names
}

// Invoke runs a capability under its own timeout.
//
// An unregistered name is refused here rather than deeper in, so a handler is
// never reached by a name the agent does not offer.
func (r *Registry) Invoke(ctx context.Context, name string, payload json.RawMessage) (any, error) {
	definition, exists := r.definitions[name]

	if !exists {
		return nil, fmt.Errorf("%w: %s", ErrUnsupported, name)
	}

	ctx, cancel := context.WithTimeout(ctx, definition.Timeout)
	defer cancel()

	return definition.Handler(ctx, payload)
}

/*
InvokeStream runs a streaming capability under the agent's own ceiling.

An unregistered name is refused here, and so is a name that answers once: a
caller cannot turn an ordinary capability into a stream, or the other way round,
by asking differently.
*/
func (r *Registry) InvokeStream(
	ctx context.Context,
	name string,
	payload json.RawMessage,
	emit func(Chunk) error,
) error {
	definition, exists := r.streams[name]

	if !exists {
		return fmt.Errorf("%w: %s", ErrUnsupported, name)
	}

	ctx, cancel := context.WithTimeout(ctx, definition.MaxDuration)
	defer cancel()

	return definition.Handler(ctx, payload, emit)
}

// Code maps a handler error to the stable code the server accepts.
func Code(err error) string {
	switch {
	case errors.Is(err, ErrUnsupported):
		return "AGENT_CAPABILITY_UNSUPPORTED"
	case errors.Is(err, ErrInvalidPayload):
		return "VALIDATION_FAILED"
	case errors.Is(err, ErrDockerUnavailable):
		return "DOCKER_UNAVAILABLE"
	case errors.Is(err, ErrAlreadyRunning):
		return "CONTAINER_ALREADY_RUNNING"
	case errors.Is(err, ErrAlreadyStopped):
		return "CONTAINER_ALREADY_STOPPED"
	case errors.Is(err, ErrDockerPermission):
		return "DOCKER_PERMISSION_DENIED"
	case errors.Is(err, ErrDockerFailed):
		return "DOCKER_OPERATION_FAILED"
	case errors.Is(err, ErrNotFound):
		return "CONTAINER_NOT_FOUND"
	case errors.Is(err, ErrNameInUse):
		return "CONTAINER_NAME_IN_USE"
	case errors.Is(err, ErrImageNotFound):
		return "IMAGE_NOT_FOUND"
	case errors.Is(err, ErrInvalidSpec):
		return "INVALID_CONTAINER_SPEC"
	case errors.Is(err, ErrStackConflict):
		return "STACK_RESOURCE_CONFLICT"
	case errors.Is(err, ErrStackAmbiguous):
		return "STACK_STATE_AMBIGUOUS"
	case errors.Is(err, ErrVolumeMissing):
		return "VOLUME_MISSING"
	case errors.Is(err, ErrStackServiceMissing):
		return "STACK_SERVICE_MISSING"
	case errors.Is(err, ErrStackLifecycleIncomplete):
		return "STACK_LIFECYCLE_INCOMPLETE"
	case errors.Is(err, ErrStackRemoveIncomplete):
		return "STACK_REMOVE_INCOMPLETE"
	case errors.Is(err, ErrReplacementFailed):
		return "REPLACEMENT_FAILED"
	case errors.Is(err, context.DeadlineExceeded):
		return "AGENT_REQUEST_EXPIRED"
	default:
		return "AGENT_CAPABILITY_FAILED"
	}
}
