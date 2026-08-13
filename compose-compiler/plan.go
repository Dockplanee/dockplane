package main

// The plan a Compose file becomes.
//
// This is Dockplane's own shape, not Compose's and not Docker's. It exists so
// that everything downstream — the control server, and later the agent —
// receives something typed and finite rather than a parsed YAML tree: a field
// that is not here cannot be asked for, whatever a Compose file contains.
//
// It is a wire contract between two processes, so it carries its own version.
// A control server that reads a plan it does not understand refuses it rather
// than working from the parts it recognises.

// PlanVersion is the shape of the plan this build produces.
//
// The same number as the protocol version while the two cannot change
// independently: the compiler is built into the control server image, so a plan
// never travels between versions of the two. Split them when that stops being
// true.
const PlanVersion = 1

// StackDeploymentPlan is a whole Compose project, resolved.
//
// Everything is ordered. Compose is a map of services and Go iterates maps in
// no particular order, so a plan built twice from one file would otherwise
// differ in ways that mean nothing — and later, a stack revision would appear
// to have changed when nothing had.
type StackDeploymentPlan struct {
	PlanVersion int    `json:"planVersion"`
	ProjectName string `json:"projectName"`

	Services []ServicePlan `json:"services"`
	Networks []NetworkPlan `json:"networks"`
	Volumes  []VolumePlan  `json:"volumes"`
}

// ServicePlan is one container the stack is made of.
//
// Deliberately close to the specification a standalone container is created
// from: the same fields mean the same things, so a stack service and a
// container an operator described by hand end up on a host the same way.
type ServicePlan struct {
	ServiceName string `json:"serviceName"`
	// Always resolved: the name from the Compose file where it asked for one,
	// and Compose's own default otherwise. Deriving it anywhere else would put
	// a second copy of Compose's naming rules outside the program that reads
	// Compose.
	ContainerName string `json:"containerName"`

	Image      string   `json:"image"`
	Hostname   string   `json:"hostname,omitempty"`
	Command    []string `json:"command,omitempty"`
	Entrypoint []string `json:"entrypoint,omitempty"`

	// Resolved values, including secrets. This is why a plan is never stored,
	// never logged and never put into an audit entry.
	Environment []EnvironmentEntry `json:"environment,omitempty"`

	Ports    []PortPlan  `json:"ports,omitempty"`
	Mounts   []MountPlan `json:"mounts,omitempty"`
	Networks []string    `json:"networks,omitempty"`

	RestartPolicy string            `json:"restartPolicy"`
	Labels        map[string]string `json:"labels,omitempty"`
	Healthcheck   *HealthcheckPlan  `json:"healthcheck,omitempty"`

	// Services that have to be running first, by service name. Ordering only:
	// Dockplane starts what a service depends on before starting it.
	DependsOn []string `json:"dependsOn,omitempty"`
}

type EnvironmentEntry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type PortPlan struct {
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort,omitempty"`
	Protocol      string `json:"protocol"`
	HostIP        string `json:"hostIp,omitempty"`
}

type MountPlan struct {
	// "volume" for a named volume, "bind" for a path on the host.
	Type     string `json:"type"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

type HealthcheckPlan struct {
	// The command Docker runs, exactly as Docker runs it. Dockplane adds no
	// shell of its own: CMD-SHELL is Docker's own semantics, and a test that
	// arrives as a bare string is Compose asking for it.
	Test       []string `json:"test"`
	IntervalMS int64    `json:"intervalMs,omitempty"`
	TimeoutMS  int64    `json:"timeoutMs,omitempty"`
	StartPerMS int64    `json:"startPeriodMs,omitempty"`
	Retries    int      `json:"retries,omitempty"`
	Disabled   bool     `json:"disabled,omitempty"`
}

// NetworkPlan is a network the stack needs.
//
// External networks are named and not created; the rest Dockplane creates. No
// driver options are carried, because none are applied yet — a plan that
// promised them would be a plan the agent silently ignored.
type NetworkPlan struct {
	Name string `json:"name"`
	// The name Docker should use, where the Compose file asked for one.
	DockerName string `json:"dockerName,omitempty"`
	External   bool   `json:"external"`
	Driver     string `json:"driver,omitempty"`
}

type VolumePlan struct {
	Name       string `json:"name"`
	DockerName string `json:"dockerName,omitempty"`
	External   bool   `json:"external"`
	Driver     string `json:"driver,omitempty"`
}
