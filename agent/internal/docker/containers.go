package docker

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
)

// Canonical Compose labels. Compose sets these itself, which is why discovery
// reads them instead of parsing container names into a guess at a project.
const (
	LabelProject         = "com.docker.compose.project"
	LabelService         = "com.docker.compose.service"
	LabelContainerNumber = "com.docker.compose.container-number"
	LabelOneOff          = "com.docker.compose.oneoff"
)

// forwardedLabels is an allow list.
//
// Labels are free-form and routinely carry deployment detail, tokens and
// internal addresses. Only the Compose labels the product actually groups by
// are forwarded; everything else stays on the host.
var forwardedLabels = map[string]bool{
	LabelProject:         true,
	LabelService:         true,
	LabelContainerNumber: true,
	LabelOneOff:          true,
	// Dockplane's own, so the control server can recognise a container it
	// built even after Docker has given the replacement a new identifier.
	// Neither carries anything an operator put there.
	LabelManaged:         true,
	LabelContainerID:     true,
	LabelDesiredConfigID: true,
}

// ContainerSummary is the normalised form of a listed container.
//
// It is a deliberate projection, not a filtered copy of the Docker payload: a
// field appears here because the product displays or groups by it.
type ContainerSummary struct {
	DockerID  string            `json:"dockerId"`
	Name      string            `json:"name"`
	Image     string            `json:"image"`
	ImageID   string            `json:"imageId,omitempty"`
	State     string            `json:"state"`
	Status    string            `json:"status"`
	Health    string            `json:"health"`
	CreatedAt time.Time         `json:"createdAt"`
	Labels    map[string]string `json:"labels,omitempty"`
}

// PortBinding is a published or exposed port.
type PortBinding struct {
	ContainerPort uint16 `json:"containerPort"`
	Protocol      string `json:"protocol"`
	HostPort      string `json:"hostPort,omitempty"`
	// HostIP is reported because binding to 0.0.0.0 rather than 127.0.0.1 is an
	// operationally meaningful difference.
	HostIP string `json:"hostIp,omitempty"`
}

// Mount describes storage attached to a container.
//
// A named volume is reported by name. A bind mount reports only its type and
// whether it is writable: the host path would expose the filesystem layout, and
// nothing in a read-only view needs it.
type Mount struct {
	Type     string `json:"type"`
	Name     string `json:"name,omitempty"`
	ReadOnly bool   `json:"readOnly"`
}

// ContainerDetail is the sanitised inspect projection.
type ContainerDetail struct {
	DockerID      string            `json:"dockerId"`
	Name          string            `json:"name"`
	Image         string            `json:"image"`
	ImageID       string            `json:"imageId,omitempty"`
	State         string            `json:"state"`
	Status        string            `json:"status"`
	Health        string            `json:"health"`
	RestartCount  int               `json:"restartCount"`
	RestartPolicy string            `json:"restartPolicy,omitempty"`
	CreatedAt     time.Time         `json:"createdAt"`
	StartedAt     *time.Time        `json:"startedAt,omitempty"`
	FinishedAt    *time.Time        `json:"finishedAt,omitempty"`
	ExitCode      *int              `json:"exitCode,omitempty"`
	Ports         []PortBinding     `json:"ports,omitempty"`
	Networks      []string          `json:"networks,omitempty"`
	Mounts        []Mount           `json:"mounts,omitempty"`
	Limits        *ResourceLimits   `json:"limits,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

// ResourceLimits reports configured limits, omitted when unset.
type ResourceLimits struct {
	MemoryBytes int64 `json:"memoryBytes,omitempty"`
	NanoCPUs    int64 `json:"nanoCpus,omitempty"`
	PidsLimit   int64 `json:"pidsLimit,omitempty"`
}

// ListContainers returns every container, running or not.
//
// Stopped containers are included because a container that should be running
// and is not is precisely what an operator needs to see.
func (e *Engine) ListContainers(ctx context.Context) ([]ContainerSummary, error) {
	raw, err := e.client.ContainerList(ctx, container.ListOptions{All: true})

	if err != nil {
		return nil, classify(err)
	}

	summaries := make([]ContainerSummary, 0, len(raw))

	for _, item := range raw {
		summaries = append(summaries, summarise(item))
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].Name < summaries[j].Name
	})

	return summaries, nil
}

// ListProjectContainers returns the containers belonging to a Compose project.
func (e *Engine) ListProjectContainers(ctx context.Context, project string) ([]ContainerSummary, error) {
	arguments := filters.NewArgs()
	arguments.Add("label", LabelProject+"="+project)

	raw, err := e.client.ContainerList(ctx, container.ListOptions{All: true, Filters: arguments})

	if err != nil {
		return nil, classify(err)
	}

	summaries := make([]ContainerSummary, 0, len(raw))

	for _, item := range raw {
		summaries = append(summaries, summarise(item))
	}

	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].Name < summaries[j].Name
	})

	return summaries, nil
}

// InspectContainer returns the sanitised detail of one container.
func (e *Engine) InspectContainer(ctx context.Context, id string) (*ContainerDetail, error) {
	raw, err := e.client.ContainerInspect(ctx, id)

	if err != nil {
		return nil, classify(err)
	}

	return sanitise(raw), nil
}

func summarise(item container.Summary) ContainerSummary {
	return ContainerSummary{
		DockerID:  item.ID,
		Name:      primaryName(item.Names),
		Image:     item.Image,
		ImageID:   item.ImageID,
		State:     item.State,
		Status:    item.Status,
		Health:    healthFromStatus(item.Status),
		CreatedAt: time.Unix(item.Created, 0).UTC(),
		Labels:    allowedLabels(item.Labels),
	}
}

/*
sanitise builds the detail view field by field.

The full inspect payload is never forwarded. It contains the environment block,
registry credentials, the entrypoint and command as configured, host paths and
the container's own filesystem layout — none of which a read-only operational
view needs, and all of which routinely hold secrets.
*/
func sanitise(raw container.InspectResponse) *ContainerDetail {
	detail := &ContainerDetail{
		DockerID:     raw.ID,
		Name:         strings.TrimPrefix(raw.Name, "/"),
		RestartCount: raw.RestartCount,
	}

	if raw.Config != nil {
		detail.Image = raw.Config.Image
		detail.Labels = allowedLabels(raw.Config.Labels)
	}

	detail.ImageID = raw.Image

	if raw.State != nil {
		detail.State = raw.State.Status
		detail.Status = raw.State.Status
		detail.Health = "none"

		if raw.State.Health != nil && raw.State.Health.Status != "" {
			detail.Health = raw.State.Health.Status
		}

		if started := parseDockerTime(raw.State.StartedAt); started != nil {
			detail.StartedAt = started
		}

		if finished := parseDockerTime(raw.State.FinishedAt); finished != nil {
			detail.FinishedAt = finished
		}

		if !raw.State.Running {
			code := raw.State.ExitCode
			detail.ExitCode = &code
		}
	}

	if created := parseDockerTime(raw.Created); created != nil {
		detail.CreatedAt = *created
	}

	if raw.HostConfig != nil {
		detail.RestartPolicy = string(raw.HostConfig.RestartPolicy.Name)
		detail.Ports = publishedPorts(raw)
		detail.Limits = limits(raw)
	}

	detail.Networks = networkNames(raw)
	detail.Mounts = mounts(raw)

	return detail
}

func publishedPorts(raw container.InspectResponse) []PortBinding {
	if raw.NetworkSettings == nil {
		return nil
	}

	var bindings []PortBinding

	for port, hostBindings := range raw.NetworkSettings.Ports {
		if len(hostBindings) == 0 {
			bindings = append(bindings, PortBinding{
				ContainerPort: uint16(port.Int()),
				Protocol:      port.Proto(),
			})

			continue
		}

		for _, binding := range hostBindings {
			bindings = append(bindings, PortBinding{
				ContainerPort: uint16(port.Int()),
				Protocol:      port.Proto(),
				HostPort:      binding.HostPort,
				HostIP:        binding.HostIP,
			})
		}
	}

	sort.Slice(bindings, func(i, j int) bool {
		if bindings[i].ContainerPort != bindings[j].ContainerPort {
			return bindings[i].ContainerPort < bindings[j].ContainerPort
		}

		return bindings[i].Protocol < bindings[j].Protocol
	})

	return bindings
}

func networkNames(raw container.InspectResponse) []string {
	if raw.NetworkSettings == nil {
		return nil
	}

	names := make([]string, 0, len(raw.NetworkSettings.Networks))

	for name := range raw.NetworkSettings.Networks {
		names = append(names, name)
	}

	sort.Strings(names)

	return names
}

func mounts(raw container.InspectResponse) []Mount {
	entries := make([]Mount, 0, len(raw.Mounts))

	for _, mount := range raw.Mounts {
		entry := Mount{Type: string(mount.Type), ReadOnly: !mount.RW}

		// Only a named volume has a name worth reporting. A bind mount's source
		// is a host path and is deliberately left out.
		if mount.Type == "volume" {
			entry.Name = mount.Name
		}

		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type < entries[j].Type
		}

		return entries[i].Name < entries[j].Name
	})

	return entries
}

func limits(raw container.InspectResponse) *ResourceLimits {
	if raw.HostConfig == nil {
		return nil
	}

	limits := &ResourceLimits{
		MemoryBytes: raw.HostConfig.Memory,
		NanoCPUs:    raw.HostConfig.NanoCPUs,
	}

	if raw.HostConfig.PidsLimit != nil {
		limits.PidsLimit = *raw.HostConfig.PidsLimit
	}

	if limits.MemoryBytes == 0 && limits.NanoCPUs == 0 && limits.PidsLimit == 0 {
		return nil
	}

	return limits
}

// allowedLabels keeps only the labels the product groups by.
func allowedLabels(labels map[string]string) map[string]string {
	if len(labels) == 0 {
		return nil
	}

	kept := make(map[string]string)

	for key, value := range labels {
		if forwardedLabels[key] {
			kept[key] = value
		}
	}

	if len(kept) == 0 {
		return nil
	}

	return kept
}

func primaryName(names []string) string {
	if len(names) == 0 {
		return ""
	}

	return strings.TrimPrefix(names[0], "/")
}

// healthFromStatus reads the health hint Docker appends to a list status, such
// as "Up 2 hours (healthy)". The list endpoint reports no structured health.
func healthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	default:
		return "none"
	}
}

func parseDockerTime(value string) *time.Time {
	if value == "" {
		return nil
	}

	parsed, err := time.Parse(time.RFC3339Nano, value)

	// Docker reports the zero time for a container that never ran.
	if err != nil || parsed.IsZero() || parsed.Year() <= 1 {
		return nil
	}

	utc := parsed.UTC()

	return &utc
}
