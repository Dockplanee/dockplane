package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	"github.com/compose-spec/compose-go/v2/loader"
	"github.com/compose-spec/compose-go/v2/types"
)

/*
Compose in, plan out.

The parsing is compose-go's, because Compose is a specification with corners —
interpolation, defaults, merge semantics, the difference between a string and a
list in six places — and a second implementation of it would be a second set of
those corners to get wrong.

What is Dockplane's is everything after: deciding which of the things a Compose
file can ask for this product actually does, and refusing the rest. Compose can
describe far more than Dockplane deploys, and the difference is refused rather
than dropped. A file that asks for something unsupported is an error, not a
deployment missing a feature the author believed they had configured.
*/

// Error codes a caller can match on.
const (
	codeParse       = "COMPOSE_PARSE_FAILED"
	codeUnsupported = "COMPOSE_FEATURE_UNSUPPORTED"
	codeInvalid     = "COMPOSE_INVALID"
	codeLimit       = "COMPOSE_LIMIT_EXCEEDED"
	codeReserved    = "COMPOSE_RESERVED_LABEL"
	codeForbidden   = "COMPOSE_FORBIDDEN_MOUNT"
)

/*
Host paths a stack may not mount.

The same list the control server and the agent refuse for a standalone
container. A Compose file is another way of asking, and it gets the same
answer — the agent still checks, because it is the one on the machine.
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

// The namespace Dockplane sets on the containers it builds.
const reservedLabelPrefix = "io.dockplane."

var (
	projectNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
	nameishPattern     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
)

// The restart policies Dockplane can apply. Compose accepts more spellings than
// Docker has behaviours, and the ones that are not modelled are refused.
var restartPolicies = map[string]string{
	"":               "no",
	"no":             "no",
	"always":         "always",
	"unless-stopped": "unless-stopped",
	"on-failure":     "on-failure",
}

// Compile turns a request into a plan, or into the reasons it is not one.
func Compile(request Request) (*StackDeploymentPlan, []Problem) {
	if problems := checkRequest(request); len(problems) > 0 {
		return nil, problems
	}

	/*
	 * `include` is checked before parsing, because the loader is told not to
	 * follow it and would otherwise skip it in silence — leaving an author with
	 * a deployment missing everything the included file described.
	 */
	if problems := checkTopLevel(request.Compose); len(problems) > 0 {
		return nil, problems
	}

	project, err := load(request)

	if err != nil {
		return nil, []Problem{{Code: codeParse, Message: composeMessage(err)}}
	}

	return build(request.ProjectName, project)
}

/*
Top-level keys the loader is configured to ignore.

Everything else is refused by compose-go or by the validator below. These two
are different: they are turned off at the loader, so nothing downstream would
ever see them.
*/
func checkTopLevel(compose string) []Problem {
	var problems []Problem

	for _, line := range strings.Split(compose, "\n") {
		key := strings.TrimSpace(line)

		if strings.HasPrefix(key, "include:") || key == "include:" {
			problems = append(problems, Problem{
				Path:    "include",
				Code:    codeUnsupported,
				Message: "include is not supported. Put the whole stack in one Compose file.",
			})

			break
		}
	}

	return problems
}

func checkRequest(request Request) []Problem {
	var problems []Problem

	if !projectNamePattern.MatchString(request.ProjectName) {
		problems = append(problems, Problem{
			Path:    "projectName",
			Code:    codeInvalid,
			Message: "A project name uses lower-case letters, digits, hyphens and underscores, and starts with a letter or digit.",
		})
	}

	if strings.TrimSpace(request.Compose) == "" {
		problems = append(problems, Problem{
			Path:    "compose",
			Code:    codeInvalid,
			Message: "There is no Compose file to read.",
		})
	}

	if len(request.Compose) > maxComposeBytes {
		problems = append(problems, Problem{
			Path:    "compose",
			Code:    codeLimit,
			Message: fmt.Sprintf("A Compose file may be at most %d bytes.", maxComposeBytes),
		})
	}

	if len(request.Environment) > maxEnvironment {
		problems = append(problems, Problem{
			Path:    "environment",
			Code:    codeLimit,
			Message: fmt.Sprintf("At most %d environment variables are accepted.", maxEnvironment),
		})
	}

	for key, value := range request.Environment {
		if len(key) > maxEnvKeyBytes {
			problems = append(problems, Problem{
				Path:    "environment",
				Code:    codeLimit,
				Message: fmt.Sprintf("An environment variable name may be at most %d bytes.", maxEnvKeyBytes),
			})

			break
		}

		if len(value) > maxEnvValueBytes {
			// The name, never the value. The value is the thing being protected.
			problems = append(problems, Problem{
				Path:    "environment." + key,
				Code:    codeLimit,
				Message: fmt.Sprintf("An environment value may be at most %d bytes.", maxEnvValueBytes),
			})

			break
		}
	}

	return problems
}

/*
Hands the Compose file to compose-go, from memory.

No file is written. compose-go takes the content directly, which matters
because the alternative would be a Compose file and an environment on disk —
readable by anything that can see the filesystem, and outliving the process if
it dies before cleaning up.

Everything that reaches outside this process is turned off: `include` and
`extends` can read other files, and both are refused as features anyway.
*/
func load(request Request) (*types.Project, error) {
	details := types.ConfigDetails{
		WorkingDir:  "/nonexistent",
		ConfigFiles: []types.ConfigFile{{Filename: "compose.yaml", Content: []byte(request.Compose)}},
		Environment: types.Mapping(request.Environment),
	}

	return loader.LoadWithContext(context.Background(), details, func(options *loader.Options) {
		options.SetProjectName(request.ProjectName, true)
		options.SkipInclude = true
		options.SkipExtends = true
		// Paths are resolved against a working directory that does not exist,
		// and nothing here should be reading the filesystem in the first place.
		options.ResolvePaths = false
		options.SkipConsistencyCheck = false
		options.SkipValidation = false
	})
}

/*
The message a parse failure becomes.

compose-go reports where it failed, which is what an author needs. It does not
report the values it interpolated, and this does not add them: an error that
quoted the string it could not parse would quote whatever had been substituted
into it.
*/
func composeMessage(err error) string {
	message := err.Error()

	if index := strings.Index(message, "\n"); index >= 0 {
		message = message[:index]
	}

	return message
}

func build(projectName string, project *types.Project) (*StackDeploymentPlan, []Problem) {
	var problems []Problem

	if len(project.Services) > maxServices {
		problems = append(problems, Problem{
			Path:    "services",
			Code:    codeLimit,
			Message: fmt.Sprintf("A stack may have at most %d services.", maxServices),
		})
	}

	if len(project.Networks) > maxNetworks {
		problems = append(problems, Problem{
			Path:    "networks",
			Code:    codeLimit,
			Message: fmt.Sprintf("A stack may have at most %d networks.", maxNetworks),
		})
	}

	if len(project.Volumes) > maxVolumes {
		problems = append(problems, Problem{
			Path:    "volumes",
			Code:    codeLimit,
			Message: fmt.Sprintf("A stack may have at most %d volumes.", maxVolumes),
		})
	}

	if len(problems) > 0 {
		return nil, problems
	}

	/*
	 * Empty lists are lists, not nothing.
	 *
	 * A nil slice marshals to `null`, so a project with no volumes would answer
	 * with a different shape from one with volumes — and whatever reads the plan
	 * would have to accept both spellings of "none".
	 */
	plan := &StackDeploymentPlan{
		PlanVersion: PlanVersion,
		ProjectName: projectName,
		Services:    []ServicePlan{},
		Networks:    []NetworkPlan{},
		Volumes:     []VolumePlan{},
	}

	for _, name := range sortedKeys(project.Services) {
		service, serviceProblems := servicePlan(projectName, name, project.Services[name])

		problems = append(problems, serviceProblems...)

		if service != nil {
			plan.Services = append(plan.Services, *service)
		}
	}

	for _, name := range sortedKeys(project.Networks) {
		network := project.Networks[name]

		if len(network.DriverOpts) > 0 {
			problems = append(problems, Problem{
				Path:    "networks." + name + ".driver_opts",
				Code:    codeUnsupported,
				Message: "Driver options are not applied by Dockplane, so a network cannot ask for them.",
			})
		}

		plan.Networks = append(plan.Networks, NetworkPlan{
			Name:       name,
			DockerName: network.Name,
			External:   bool(network.External),
			Driver:     network.Driver,
		})
	}

	for _, name := range sortedKeys(project.Volumes) {
		volume := project.Volumes[name]

		if len(volume.DriverOpts) > 0 {
			problems = append(problems, Problem{
				Path:    "volumes." + name + ".driver_opts",
				Code:    codeUnsupported,
				Message: "Driver options are not applied by Dockplane, so a volume cannot ask for them.",
			})
		}

		plan.Volumes = append(plan.Volumes, VolumePlan{
			Name:       name,
			DockerName: volume.Name,
			External:   bool(volume.External),
			Driver:     volume.Driver,
		})
	}

	if len(project.Configs) > 0 {
		problems = append(problems, Problem{
			Path:    "configs",
			Code:    codeUnsupported,
			Message: "Compose configs are not supported by Dockplane.",
		})
	}

	if len(project.Secrets) > 0 {
		problems = append(problems, Problem{
			Path:    "secrets",
			Code:    codeUnsupported,
			Message: "Compose secrets are not supported. Set values as environment variables on the stack instead.",
		})
	}

	if len(problems) > 0 {
		return nil, problems
	}

	return plan, nil
}

/*
containerName is the name Docker will know a service's container by.

Compose's own convention when the file does not name one: the project, the
service and the ordinal, joined by hyphens. It is resolved here rather than by
whatever consumes the plan, because this is the program that knows Compose's
rules and one naming scheme is enough.
*/
func containerName(projectName string, service string, requested string) string {
	if requested != "" {
		return requested
	}

	return fmt.Sprintf("%s-%s-1", projectName, service)
}

func servicePlan(
	projectName string,
	name string,
	service types.ServiceConfig,
) (*ServicePlan, []Problem) {
	at := func(property string) string { return "services." + name + "." + property }

	problems := unsupportedIn(name, service)

	if service.Image == "" {
		problems = append(problems, Problem{
			Path:    at("image"),
			Code:    codeInvalid,
			Message: "A service needs an image. Dockplane does not build images.",
		})
	}

	if service.ContainerName != "" && !nameishPattern.MatchString(service.ContainerName) {
		problems = append(problems, Problem{
			Path:    at("container_name"),
			Code:    codeInvalid,
			Message: "That is not a container name Docker accepts.",
		})
	}

	restart, known := restartPolicies[service.Restart]

	if !known {
		problems = append(problems, Problem{
			Path:    at("restart"),
			Code:    codeUnsupported,
			Message: fmt.Sprintf("Dockplane does not apply the restart policy %q.", service.Restart),
		})
	}

	plan := &ServicePlan{
		ServiceName:   name,
		ContainerName: containerName(projectName, name, service.ContainerName),
		Image:         service.Image,
		Hostname:      service.Hostname,
		Command:       []string(service.Command),
		Entrypoint:    []string(service.Entrypoint),
		RestartPolicy: restart,
	}

	for _, key := range sortedKeys(service.Environment) {
		value := service.Environment[key]

		if value == nil {
			/*
			 * `FOO` with no value and nothing in the environment to resolve it
			 * from. Compose leaves it unset; Dockplane refuses, because a
			 * container starting without a variable its author listed is a
			 * failure that happens later and somewhere else.
			 */
			problems = append(problems, Problem{
				Path:    at("environment." + key),
				Code:    codeInvalid,
				Message: fmt.Sprintf("%s has no value, and none was supplied for the stack.", key),
			})

			continue
		}

		plan.Environment = append(plan.Environment, EnvironmentEntry{Key: key, Value: *value})
	}

	for index, port := range service.Ports {
		portPlan, portProblems := portPlanFor(at(fmt.Sprintf("ports[%d]", index)), port)

		problems = append(problems, portProblems...)

		if portPlan != nil {
			plan.Ports = append(plan.Ports, *portPlan)
		}
	}

	for index, volume := range service.Volumes {
		mount, mountProblems := mountPlanFor(at(fmt.Sprintf("volumes[%d]", index)), volume)

		problems = append(problems, mountProblems...)

		if mount != nil {
			plan.Mounts = append(plan.Mounts, *mount)
		}
	}

	for _, network := range sortedKeys(service.Networks) {
		if config := service.Networks[network]; config != nil && len(config.Aliases) > 0 {
			problems = append(problems, Problem{
				Path:    at("networks." + network + ".aliases"),
				Code:    codeUnsupported,
				Message: "Network aliases are not applied by Dockplane yet.",
			})
		}

		plan.Networks = append(plan.Networks, network)
	}

	for _, key := range sortedKeys(service.Labels) {
		if strings.HasPrefix(key, reservedLabelPrefix) {
			problems = append(problems, Problem{
				Path:    at("labels." + key),
				Code:    codeReserved,
				Message: "Labels beginning io.dockplane. are set by Dockplane and cannot be given in a Compose file.",
			})

			continue
		}

		if plan.Labels == nil {
			plan.Labels = map[string]string{}
		}

		plan.Labels[key] = service.Labels[key]
	}

	for _, dependency := range sortedKeys(service.DependsOn) {
		condition := service.DependsOn[dependency].Condition

		/*
		 * Only the condition Dockplane can honour.
		 *
		 * `service_started` is ordering, which the deployment can guarantee.
		 * The others wait for a health check or a clean exit, and a plan that
		 * carried them would be a plan promising something nothing implements
		 * — the deployment would start the service anyway and the author would
		 * never know their condition was ignored.
		 */
		if condition != "" && condition != types.ServiceConditionStarted {
			problems = append(problems, Problem{
				Path:    at("depends_on." + dependency + ".condition"),
				Code:    codeUnsupported,
				Message: fmt.Sprintf("Dockplane starts dependencies in order and cannot wait for %q.", condition),
			})

			continue
		}

		plan.DependsOn = append(plan.DependsOn, dependency)
	}

	if service.HealthCheck != nil {
		plan.Healthcheck = healthcheckPlanFor(service.HealthCheck)
	}

	if len(problems) > 0 {
		return nil, problems
	}

	return plan, nil
}

/*
Everything a service may not ask for.

Each of these is refused rather than dropped. Several are security boundaries
Dockplane does not cross for a standalone container either, and the rest are
features it does not implement — an author who writes one and gets a deployment
without it has been told something untrue.
*/
func unsupportedIn(name string, service types.ServiceConfig) []Problem {
	at := func(property string) string { return "services." + name + "." + property }

	var problems []Problem

	refuse := func(condition bool, property, message string) {
		if condition {
			problems = append(problems, Problem{Path: at(property), Code: codeUnsupported, Message: message})
		}
	}

	refuse(service.Build != nil, "build", "Image builds are not supported. Use a pre-built image.")
	refuse(len(service.Configs) > 0, "configs", "Compose configs are not supported.")
	refuse(len(service.Secrets) > 0, "secrets",
		"Compose secrets are not supported. Set values as environment variables on the stack instead.")
	refuse(service.Extends != nil, "extends", "extends is not supported.")
	refuse(service.Deploy != nil, "deploy", "deploy is not supported.")
	refuse(service.Develop != nil, "develop", "develop is not supported.")
	refuse(service.Privileged, "privileged", "Privileged containers are not supported by Dockplane.")
	refuse(len(service.CapAdd) > 0, "cap_add", "Added capabilities are not supported by Dockplane.")
	refuse(len(service.Devices) > 0, "devices", "Devices are not supported by Dockplane.")
	refuse(service.Pid != "", "pid", "Sharing a process namespace is not supported by Dockplane.")
	refuse(service.Ipc != "", "ipc", "Sharing an IPC namespace is not supported by Dockplane.")
	refuse(service.NetworkMode != "", "network_mode",
		"network_mode is not supported. Attach the service to a network instead.")
	refuse(len(service.GroupAdd) > 0, "group_add", "group_add is not supported by Dockplane.")
	refuse(service.Runtime != "", "runtime", "runtime is not supported by Dockplane.")
	refuse(len(service.Sysctls) > 0, "sysctls", "sysctls are not supported by Dockplane.")
	refuse(len(service.CapDrop) > 0, "cap_drop", "cap_drop is not supported by Dockplane yet.")
	refuse(service.Scale != nil && *service.Scale != 1, "scale",
		"Running more than one container per service is not supported yet.")

	return problems
}

func portPlanFor(path string, port types.ServicePortConfig) (*PortPlan, []Problem) {
	protocol := port.Protocol

	if protocol == "" {
		protocol = "tcp"
	}

	if protocol != "tcp" && protocol != "udp" {
		return nil, []Problem{{
			Path:    path,
			Code:    codeUnsupported,
			Message: fmt.Sprintf("Dockplane publishes TCP and UDP ports, not %q.", protocol),
		}}
	}

	if port.Target < 1 || port.Target > 65535 {
		return nil, []Problem{{
			Path:    path,
			Code:    codeInvalid,
			Message: "A container port must be between 1 and 65535.",
		}}
	}

	/*
	 * A range is a single published entry to Compose and several published
	 * ports to Docker. Nothing downstream expands one, so a plan carrying it
	 * would publish the first port and quietly drop the rest.
	 */
	if strings.Contains(port.Published, "-") {
		return nil, []Problem{{
			Path:    path,
			Code:    codeUnsupported,
			Message: "Port ranges are not supported. List the ports individually.",
		}}
	}

	plan := &PortPlan{ContainerPort: int(port.Target), Protocol: protocol, HostIP: port.HostIP}

	if port.Published != "" {
		published := 0

		if _, err := fmt.Sscanf(port.Published, "%d", &published); err != nil || published < 1 || published > 65535 {
			return nil, []Problem{{
				Path:    path,
				Code:    codeInvalid,
				Message: "A published port must be a number between 1 and 65535.",
			}}
		}

		plan.HostPort = published
	}

	return plan, nil
}

func mountPlanFor(path string, volume types.ServiceVolumeConfig) (*MountPlan, []Problem) {
	switch volume.Type {
	case "volume":
		return &MountPlan{
			Type:     "volume",
			Source:   volume.Source,
			Target:   volume.Target,
			ReadOnly: volume.ReadOnly,
		}, nil

	case "bind":
		if forbiddenBind(volume.Source) {
			return nil, []Problem{{
				Path:    path,
				Code:    codeForbidden,
				Message: "Dockplane does not mount this path from the host.",
			}}
		}

		if !strings.HasPrefix(volume.Source, "/") {
			return nil, []Problem{{
				Path:    path,
				Code:    codeInvalid,
				Message: "A bind mount needs an absolute path on the host.",
			}}
		}

		return &MountPlan{
			Type:     "bind",
			Source:   volume.Source,
			Target:   volume.Target,
			ReadOnly: volume.ReadOnly,
		}, nil

	default:
		return nil, []Problem{{
			Path:    path,
			Code:    codeUnsupported,
			Message: fmt.Sprintf("Dockplane mounts named volumes and host paths, not %q.", volume.Type),
		}}
	}
}

func healthcheckPlanFor(check *types.HealthCheckConfig) *HealthcheckPlan {
	plan := &HealthcheckPlan{Test: []string(check.Test)}

	if check.Disable {
		plan.Disabled = true
	}

	if check.Interval != nil {
		plan.IntervalMS = int64(*check.Interval) / 1_000_000
	}

	if check.Timeout != nil {
		plan.TimeoutMS = int64(*check.Timeout) / 1_000_000
	}

	if check.StartPeriod != nil {
		plan.StartPerMS = int64(*check.StartPeriod) / 1_000_000
	}

	if check.Retries != nil {
		plan.Retries = int(*check.Retries)
	}

	return plan
}

func forbiddenBind(source string) bool {
	clean := strings.TrimRight(strings.TrimSpace(source), "/")

	if clean == "" {
		return true
	}

	for _, forbidden := range forbiddenBindSources {
		if clean == forbidden || strings.HasPrefix(clean, forbidden+"/") {
			return true
		}
	}

	return false
}

/*
Map keys in an order that does not depend on the run.

Go randomises map iteration, so a plan built twice from one file would differ in
the order of its services, its variables and its labels. Nothing about those
orders carries meaning, which is exactly why they must not change: a stack
revision that looked different every time would make a real change impossible
to see.
*/
func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))

	for key := range values {
		keys = append(keys, key)
	}

	sort.Strings(keys)

	return keys
}

func newBytesReader(raw []byte) io.Reader {
	return bytes.NewReader(raw)
}
