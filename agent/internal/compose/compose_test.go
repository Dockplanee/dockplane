package compose_test

import (
	"testing"

	"github.com/dockplane/dockplane/agent/internal/compose"
	"github.com/dockplane/dockplane/agent/internal/docker"
)

func member(id, name, service, state string) docker.ContainerSummary {
	return docker.ContainerSummary{
		DockerID: id,
		Name:     name,
		State:    state,
		Labels: map[string]string{
			docker.LabelProject: "shop",
			docker.LabelService: service,
		},
	}
}

func TestGroupUsesComposeLabels(t *testing.T) {
	projects := compose.Group([]docker.ContainerSummary{
		member("a", "shop-web-1", "web", "running"),
		member("b", "shop-db-1", "db", "running"),
	})

	if len(projects) != 1 {
		t.Fatalf("got %d projects, want 1", len(projects))
	}

	project := projects[0]

	if project.Name != "shop" {
		t.Errorf("name = %q, want shop", project.Name)
	}

	if project.ServiceCount != 2 || project.RunningCount != 2 {
		t.Errorf("services = %d, running = %d", project.ServiceCount, project.RunningCount)
	}

	if project.Status != "running" {
		t.Errorf("status = %q, want running", project.Status)
	}
}

func TestContainersWithoutLabelsAreNotGrouped(t *testing.T) {
	// A name that looks like Compose output is not evidence of a project.
	projects := compose.Group([]docker.ContainerSummary{
		{DockerID: "a", Name: "shop-web-1", State: "running"},
		{DockerID: "b", Name: "shop_db_1", State: "running"},
	})

	if len(projects) != 0 {
		t.Fatalf("got %d projects, want none inferred from names", len(projects))
	}
}

func TestAPartiallyRunningProjectIsDegraded(t *testing.T) {
	projects := compose.Group([]docker.ContainerSummary{
		member("a", "shop-web-1", "web", "running"),
		member("b", "shop-db-1", "db", "exited"),
	})

	if projects[0].Status != "degraded" {
		t.Errorf("status = %q, want degraded", projects[0].Status)
	}

	if projects[0].RunningCount != 1 {
		t.Errorf("running = %d, want 1", projects[0].RunningCount)
	}
}

func TestAStoppedProjectIsReportedStopped(t *testing.T) {
	projects := compose.Group([]docker.ContainerSummary{
		member("a", "shop-web-1", "web", "exited"),
	})

	if projects[0].Status != "stopped" {
		t.Errorf("status = %q, want stopped", projects[0].Status)
	}
}

func TestAProjectLabelWithoutAServiceLabelStillCounts(t *testing.T) {
	projects := compose.Group([]docker.ContainerSummary{{
		DockerID: "a",
		Name:     "orphan",
		State:    "running",
		Labels:   map[string]string{docker.LabelProject: "shop"},
	}})

	if len(projects) != 1 || projects[0].ServiceCount != 1 {
		t.Fatalf("projects = %+v", projects)
	}

	if projects[0].Services[0].Name != "unknown" {
		t.Errorf("service name = %q, want unknown", projects[0].Services[0].Name)
	}
}

func TestFindReturnsNilForAnUnknownProject(t *testing.T) {
	if project := compose.Find(nil, "absent"); project != nil {
		t.Fatalf("got %+v, want nil", project)
	}
}
