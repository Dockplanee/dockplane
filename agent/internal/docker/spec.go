package docker

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

/*
The configuration a container may be created with.

This is the whole of it. A caller describes what it wants in these fields and
nothing else, and the agent builds the Docker request from them field by field.
The alternative — accepting a Docker API payload and passing it on — would make
every option Docker has ever had part of Dockplane's remote surface, including
the ones that hand out the host: privileged, pid host, arbitrary devices, the
Docker socket as a bind mount.

So the shape is the boundary. A field that is not here cannot be asked for, and
a value that does not validate is refused before the engine is called.

The server validates the same fields before it dispatches. This runs anyway: the
server's check is what tells an operator they made a mistake, and this one is
what the host is actually defended by.
*/
type ContainerSpec struct {
	Name          string            `json:"name"`
	Image         string            `json:"image"`
	Hostname      string            `json:"hostname,omitempty"`
	Command       []string          `json:"command,omitempty"`
	Entrypoint    []string          `json:"entrypoint,omitempty"`
	Env           []EnvVar          `json:"env,omitempty"`
	Ports         []PortSpec        `json:"ports,omitempty"`
	Mounts        []MountSpec       `json:"mounts,omitempty"`
	Networks      []string          `json:"networks,omitempty"`
	RestartPolicy string            `json:"restartPolicy,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	Healthcheck   *HealthcheckSpec  `json:"healthcheck,omitempty"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type PortSpec struct {
	ContainerPort uint16 `json:"containerPort"`
	HostPort      uint16 `json:"hostPort"`
	Protocol      string `json:"protocol"`
	// Empty binds every address, which is Docker's own default.
	HostIP string `json:"hostIp,omitempty"`
}

type MountSpec struct {
	// "volume" for a named volume, "bind" for a path on the host.
	Type     string `json:"type"`
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

type HealthcheckSpec struct {
	Test       []string `json:"test"`
	IntervalMS int64    `json:"intervalMs,omitempty"`
	TimeoutMS  int64    `json:"timeoutMs,omitempty"`
	StartPerMS int64    `json:"startPeriodMs,omitempty"`
	Retries    int      `json:"retries,omitempty"`
}

var ErrInvalidSpec = errors.New("invalid container specification")

var (
	// Docker's own container name rule.
	namePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	// A reference, not a command: no whitespace and no shell metacharacters.
	imagePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$`)
	// POSIX-ish, and deliberately not permitting `=`, which would smuggle a
	// second assignment into one variable.
	envKeyPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,254}$`)
	volumeNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	networkPattern    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
	labelKeyPattern   = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
	hostnamePattern   = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
)

// Restart policies Docker accepts. `on-failure` carries a retry count, which is
// expressed as `on-failure` here and defaulted by the engine.
var restartPolicies = map[string]bool{
	"":               true,
	"no":             true,
	"always":         true,
	"unless-stopped": true,
	"on-failure":     true,
}

/*
Paths on the host that are never a legitimate bind source.

A bind mount is the one field in this spec that reaches outside the container,
and mounting the Docker socket into a container is equivalent to handing over
the host — it is how a container escape is normally written. The agent already
runs with access to that socket; it must not become a way to lend it out.

This is a floor, not a security boundary on its own. Anyone who can bind-mount
arbitrary host paths has considerable power regardless, which is why
`containers.create` is a permission an operator is granted deliberately.
*/
var forbiddenBindSources = []string{
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/var/lib/docker",
	"/proc",
	"/sys",
	"/dev",
	"/boot",
	"/etc/shadow",
	"/root/.ssh",
	"/var/lib/dockplane-agent",
}

// Validate refuses anything the agent will not build a container from.
func (s *ContainerSpec) Validate() error {
	if !namePattern.MatchString(s.Name) {
		return fmt.Errorf("%w: name", ErrInvalidSpec)
	}

	if !imagePattern.MatchString(s.Image) {
		return fmt.Errorf("%w: image", ErrInvalidSpec)
	}

	if s.Hostname != "" && !hostnamePattern.MatchString(s.Hostname) {
		return fmt.Errorf("%w: hostname", ErrInvalidSpec)
	}

	if !restartPolicies[s.RestartPolicy] {
		return fmt.Errorf("%w: restartPolicy", ErrInvalidSpec)
	}

	if err := s.validateEnv(); err != nil {
		return err
	}

	if err := s.validatePorts(); err != nil {
		return err
	}

	if err := s.validateMounts(); err != nil {
		return err
	}

	for _, network := range s.Networks {
		if !networkPattern.MatchString(network) {
			return fmt.Errorf("%w: network %q", ErrInvalidSpec, network)
		}
	}

	for key := range s.Labels {
		if !labelKeyPattern.MatchString(key) {
			return fmt.Errorf("%w: label %q", ErrInvalidSpec, key)
		}
	}

	if s.Healthcheck != nil && len(s.Healthcheck.Test) == 0 {
		return fmt.Errorf("%w: healthcheck test", ErrInvalidSpec)
	}

	return nil
}

func (s *ContainerSpec) validateEnv() error {
	seen := make(map[string]bool, len(s.Env))

	for _, variable := range s.Env {
		if !envKeyPattern.MatchString(variable.Key) {
			return fmt.Errorf("%w: environment key %q", ErrInvalidSpec, variable.Key)
		}

		if seen[variable.Key] {
			return fmt.Errorf("%w: environment key %q given twice", ErrInvalidSpec, variable.Key)
		}

		// A newline would end the assignment and begin another one.
		if strings.ContainsAny(variable.Value, "\x00\n\r") {
			return fmt.Errorf("%w: environment value for %q", ErrInvalidSpec, variable.Key)
		}

		seen[variable.Key] = true
	}

	return nil
}

func (s *ContainerSpec) validatePorts() error {
	// Two bindings of one host port would be accepted by this agent and
	// refused by the engine halfway through creating the container.
	seen := make(map[string]bool, len(s.Ports))

	for _, port := range s.Ports {
		if port.ContainerPort == 0 {
			return fmt.Errorf("%w: container port", ErrInvalidSpec)
		}

		if port.Protocol != "tcp" && port.Protocol != "udp" {
			return fmt.Errorf("%w: protocol %q", ErrInvalidSpec, port.Protocol)
		}

		if port.HostIP != "" && !isAddress(port.HostIP) {
			return fmt.Errorf("%w: bind address %q", ErrInvalidSpec, port.HostIP)
		}

		if port.HostPort != 0 {
			key := fmt.Sprintf("%s:%d/%s", port.HostIP, port.HostPort, port.Protocol)

			if seen[key] {
				return fmt.Errorf("%w: host port %d bound twice", ErrInvalidSpec, port.HostPort)
			}

			seen[key] = true
		}
	}

	return nil
}

func (s *ContainerSpec) validateMounts() error {
	targets := make(map[string]bool, len(s.Mounts))

	for _, mount := range s.Mounts {
		if !strings.HasPrefix(mount.Target, "/") || strings.Contains(mount.Target, "..") {
			return fmt.Errorf("%w: mount target %q", ErrInvalidSpec, mount.Target)
		}

		if targets[mount.Target] {
			return fmt.Errorf("%w: mount target %q used twice", ErrInvalidSpec, mount.Target)
		}

		targets[mount.Target] = true

		switch mount.Type {
		case "volume":
			if !volumeNamePattern.MatchString(mount.Source) {
				return fmt.Errorf("%w: volume name %q", ErrInvalidSpec, mount.Source)
			}
		case "bind":
			if err := validateBindSource(mount.Source); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%w: mount type %q", ErrInvalidSpec, mount.Type)
		}
	}

	return nil
}

func validateBindSource(source string) error {
	if !strings.HasPrefix(source, "/") || strings.Contains(source, "..") {
		return fmt.Errorf("%w: bind source %q must be an absolute path", ErrInvalidSpec, source)
	}

	clean := strings.TrimRight(source, "/")

	if clean == "" {
		return fmt.Errorf("%w: bind source may not be the root filesystem", ErrInvalidSpec)
	}

	for _, forbidden := range forbiddenBindSources {
		if clean == forbidden || strings.HasPrefix(clean, forbidden+"/") {
			return fmt.Errorf("%w: bind source %q is not permitted", ErrInvalidSpec, source)
		}
	}

	return nil
}

func isAddress(value string) bool {
	// Deliberately narrow: the addresses a person binds a published port to.
	return value == "127.0.0.1" || value == "0.0.0.0" || value == "::1" || value == "::"
}

/*
Ownership labels the agent always applies.

Every container Dockplane creates says so, so that discovery can tell what it is
responsible for and an operator can tell where a container came from without
asking. These are applied after the caller's labels and cannot be overridden by
them.
*/
const (
	LabelManaged = "io.dockplane.managed"
	LabelStack   = "io.dockplane.stack"
)

// Labels returns the label set the container is created with, the agent's own
// last so a caller cannot claim to be something it is not.
func (s *ContainerSpec) LabelSet(stack string) map[string]string {
	labels := make(map[string]string, len(s.Labels)+2)

	for key, value := range s.Labels {
		labels[key] = value
	}

	labels[LabelManaged] = "true"

	if stack != "" {
		labels[LabelStack] = stack
	} else {
		delete(labels, LabelStack)
	}

	return labels
}

// SortedEnv renders the environment the way Docker wants it, in a stable order
// so that two identical specifications produce identical containers.
func (s *ContainerSpec) SortedEnv() []string {
	rendered := make([]string, 0, len(s.Env))

	for _, variable := range s.Env {
		rendered = append(rendered, variable.Key+"="+variable.Value)
	}

	sort.Strings(rendered)

	return rendered
}
