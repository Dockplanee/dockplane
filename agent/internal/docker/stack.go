package docker

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

/*
A stack, as the agent receives one.

The control server parses Compose; this does not. What arrives here is a plan
somebody already resolved: a list of services with the same typed fields a
single container is created from, plus the networks and volumes they need. There
is no YAML, no interpolation and no Compose vocabulary on this side of the
gateway, which is why the agent needs no Compose parser to deploy a stack.

Like every other payload the agent accepts, a field that is not modelled here
cannot be asked for — whatever a Compose file contained.
*/

// StackPlanVersion is the plan shape this agent understands.
//
// A plan from a newer control server is refused rather than partly applied: the
// parts it does understand would be a deployment nobody described.
const StackPlanVersion = 1

// Labels a stack's resources carry, so the agent can recognise its own work.
const (
	LabelStackID         = "io.dockplane.stack-id"
	LabelStackRevisionID = "io.dockplane.stack-revision-id"
	LabelStackService    = "io.dockplane.stack-service"
	// The logical name a volume or network has inside the stack, which is what
	// survives a revision. A revision identity would not: a volume outlives the
	// configuration that first asked for it.
	LabelStackVolume  = "io.dockplane.stack-volume"
	LabelStackNetwork = "io.dockplane.stack-network"
)

// StackPlan is everything needed to put one stack on this host.
type StackPlan struct {
	PlanVersion int    `json:"planVersion"`
	StackID     string `json:"stackId"`
	RevisionID  string `json:"revisionId"`
	ProjectName string `json:"projectName"`

	Networks []StackNetwork `json:"networks"`
	Volumes  []StackVolume  `json:"volumes"`
	Services []StackService `json:"services"`
}

// StackService is one container, and the identity the server gave it.
type StackService struct {
	ServiceName string `json:"serviceName"`
	// The Dockplane container resource this service is, across replacements.
	// Allocated by the server; the agent never invents one.
	ContainerID string `json:"containerId"`
	// The name Docker will know it by, resolved by the compiler rather than by
	// a second naming scheme here.
	ContainerName string `json:"containerName"`

	Spec ContainerSpec `json:"spec"`

	// Services that must be running first, by service name.
	DependsOn []string `json:"dependsOn,omitempty"`
}

// StackNetwork is a network the stack needs.
type StackNetwork struct {
	// The logical name inside the stack, which is what ownership is keyed on.
	Name string `json:"name"`
	// The name Docker should use.
	DockerName string `json:"dockerName"`
	Driver     string `json:"driver,omitempty"`
}

type StackVolume struct {
	Name       string `json:"name"`
	DockerName string `json:"dockerName"`
	Driver     string `json:"driver,omitempty"`
}

var (
	ErrStackPlanUnsupported = errors.New("unsupported stack plan version")
	ErrStackPlanInvalid     = errors.New("invalid stack plan")
	// Something on the host has the name this stack wants and is not this
	// stack's. Nothing is renamed, removed or adopted on that basis.
	ErrStackResourceConflict = errors.New("a resource of that name belongs to something else")
)

/*
Validate checks a plan before anything on the host is touched.

Everything that can be established without asking Docker is established here, so
a plan that is wrong in an obvious way produces no containers, no networks and
no volumes at all. The control server checked all of it too; this is the copy
that runs on the machine.
*/
func (p *StackPlan) Validate() error {
	if p.PlanVersion != StackPlanVersion {
		return fmt.Errorf("%w: %d", ErrStackPlanUnsupported, p.PlanVersion)
	}

	if p.StackID == "" || p.RevisionID == "" {
		return fmt.Errorf("%w: a plan carries the stack and revision it is", ErrStackPlanInvalid)
	}

	if len(p.Services) == 0 {
		return fmt.Errorf("%w: a stack with no services deploys nothing", ErrStackPlanInvalid)
	}

	services := map[string]bool{}
	names := map[string]bool{}
	resources := map[string]bool{}

	for index := range p.Services {
		service := &p.Services[index]

		if service.ServiceName == "" {
			return fmt.Errorf("%w: a service has no name", ErrStackPlanInvalid)
		}

		if services[service.ServiceName] {
			return fmt.Errorf("%w: %s is listed twice", ErrStackPlanInvalid, service.ServiceName)
		}

		services[service.ServiceName] = true

		if service.ContainerID == "" {
			return fmt.Errorf(
				"%w: %s has no Dockplane container identity",
				ErrStackPlanInvalid,
				service.ServiceName,
			)
		}

		if resources[service.ContainerID] {
			return fmt.Errorf(
				"%w: two services claim the same Dockplane container",
				ErrStackPlanInvalid,
			)
		}

		resources[service.ContainerID] = true

		if service.ContainerName == "" {
			return fmt.Errorf(
				"%w: %s has no container name",
				ErrStackPlanInvalid,
				service.ServiceName,
			)
		}

		if names[service.ContainerName] {
			return fmt.Errorf(
				"%w: two services would be called %s",
				ErrStackPlanInvalid,
				service.ContainerName,
			)
		}

		names[service.ContainerName] = true

		// The same specification a single container is checked against: the
		// forbidden bind sources, the reserved labels, the image reference.
		service.Spec.Name = service.ContainerName

		if err := service.Spec.Validate(); err != nil {
			return fmt.Errorf("%s: %w", service.ServiceName, err)
		}
	}

	for _, service := range p.Services {
		for _, dependency := range service.DependsOn {
			if !services[dependency] {
				return fmt.Errorf(
					"%w: %s depends on %s, which the plan does not contain",
					ErrStackPlanInvalid,
					service.ServiceName,
					dependency,
				)
			}
		}
	}

	if _, err := p.StartOrder(); err != nil {
		return err
	}

	return nil
}

/*
StartOrder is the order services may be started in.

A topological sort of what depends on what, and alphabetical within a level so
two deployments of one plan do the same thing in the same sequence. The compiler
refuses a cycle; this refuses one too, because a plan that cannot be ordered is
one the agent must not start half of.
*/
func (p *StackPlan) StartOrder() ([]string, error) {
	pending := map[string][]string{}

	for _, service := range p.Services {
		pending[service.ServiceName] = append([]string{}, service.DependsOn...)
	}

	var order []string

	for len(pending) > 0 {
		var ready []string

		for name, dependencies := range pending {
			satisfied := true

			for _, dependency := range dependencies {
				if _, waiting := pending[dependency]; waiting {
					satisfied = false
					break
				}
			}

			if satisfied {
				ready = append(ready, name)
			}
		}

		if len(ready) == 0 {
			remaining := make([]string, 0, len(pending))

			for name := range pending {
				remaining = append(remaining, name)
			}

			sort.Strings(remaining)

			return nil, fmt.Errorf(
				"%w: these services depend on each other: %s",
				ErrStackPlanInvalid,
				strings.Join(remaining, ", "),
			)
		}

		sort.Strings(ready)
		order = append(order, ready...)

		for _, name := range ready {
			delete(pending, name)
		}
	}

	return order, nil
}

/** The labels a service container carries, set by the agent and not by a caller. */
func (p *StackPlan) serviceLabels(service *StackService) map[string]string {
	labels := service.Spec.LabelSet("", service.ContainerID, "")

	labels[LabelStackID] = p.StackID
	labels[LabelStackRevisionID] = p.RevisionID
	labels[LabelStackService] = service.ServiceName

	return labels
}

/*
Whether a resource already on the host is this stack's to use.

Ownership is proven from the labels Dockplane set when it created the resource,
never from the name. A volume called `shop_data` that Dockplane did not create
holds somebody's data, and mounting it into a new stack because the name matched
would be the worst thing this code could do.
*/
func ownedByStack(labels map[string]string, stackID string, key string, value string) bool {
	return labels[LabelManaged] == "true" && labels[LabelStackID] == stackID && labels[key] == value
}
