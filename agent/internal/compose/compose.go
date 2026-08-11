// Package compose groups discovered containers into Compose projects.
//
// Grouping reads the labels Compose writes, not container names. A name is a
// convention an operator can break and an attacker can imitate; the label is
// what Compose itself uses to find its own containers.
//
// Nothing here runs Compose. There is no up, down or deploy, and the package
// never touches a Compose file on disk.
package compose

import (
	"sort"
	"strings"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

// Project is a discovered Compose project.
//
// The working directory and config file paths that Compose also records are
// deliberately not reported: they describe the host's filesystem layout and a
// read-only view has no use for them.
type Project struct {
	Name         string    `json:"projectName"`
	Status       string    `json:"status"`
	ServiceCount int       `json:"serviceCount"`
	RunningCount int       `json:"runningCount"`
	Services     []Service `json:"services,omitempty"`
}

// Service is one service within a project.
type Service struct {
	Name         string   `json:"name"`
	ContainerIDs []string `json:"containerIds"`
	Running      int      `json:"running"`
	Total        int      `json:"total"`
	State        string   `json:"state"`
}

// Group builds projects from listed containers.
//
// A container without a project label belongs to no project and is simply not
// grouped. Guessing a project from its name would invent structure that Compose
// never declared.
func Group(containers []docker.ContainerSummary) []Project {
	byProject := make(map[string]map[string][]docker.ContainerSummary)

	for _, item := range containers {
		project := item.Labels[docker.LabelProject]

		if project == "" {
			continue
		}

		service := item.Labels[docker.LabelService]

		if service == "" {
			// Compose always sets a service label alongside a project label. A
			// container with one and not the other is reported under a neutral
			// name rather than dropped, so the project's count stays truthful.
			service = "unknown"
		}

		if byProject[project] == nil {
			byProject[project] = make(map[string][]docker.ContainerSummary)
		}

		byProject[project][service] = append(byProject[project][service], item)
	}

	projects := make([]Project, 0, len(byProject))

	for name, services := range byProject {
		projects = append(projects, build(name, services))
	}

	sort.Slice(projects, func(i, j int) bool {
		return projects[i].Name < projects[j].Name
	})

	return projects
}

// Find returns one project by name, or nil when it is not present.
func Find(containers []docker.ContainerSummary, name string) *Project {
	for _, project := range Group(containers) {
		if project.Name == name {
			return &project
		}
	}

	return nil
}

func build(name string, services map[string][]docker.ContainerSummary) Project {
	project := Project{Name: name, ServiceCount: len(services)}

	for serviceName, members := range services {
		service := Service{Name: serviceName, Total: len(members)}

		for _, member := range members {
			service.ContainerIDs = append(service.ContainerIDs, member.DockerID)

			if isRunning(member.State) {
				service.Running++
			}
		}

		sort.Strings(service.ContainerIDs)
		service.State = serviceState(service.Running, service.Total)

		project.RunningCount += service.Running
		project.Services = append(project.Services, service)
	}

	sort.Slice(project.Services, func(i, j int) bool {
		return project.Services[i].Name < project.Services[j].Name
	})

	project.Status = projectStatus(project)

	return project
}

func isRunning(state string) bool {
	return strings.EqualFold(state, "running")
}

func serviceState(running, total int) string {
	switch {
	case running == 0:
		return "stopped"
	case running == total:
		return "running"
	default:
		return "degraded"
	}
}

// projectStatus summarises the services rather than the container count, so one
// service with three replicas does not outvote three single-container services.
func projectStatus(project Project) string {
	if len(project.Services) == 0 {
		return "unknown"
	}

	running := 0

	for _, service := range project.Services {
		if service.State == "running" {
			running++
		}
	}

	switch {
	case running == 0:
		return "stopped"
	case running == len(project.Services):
		return "running"
	default:
		return "degraded"
	}
}
