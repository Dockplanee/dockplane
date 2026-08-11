//go:build docker_integration

// These tests need a real Docker daemon and are excluded from the default
// build. Run them with:
//
//	go test -tags docker_integration ./internal/docker/
//
// The harness creates and removes throwaway containers with the Docker CLI.
// The product code deliberately cannot do that: its client interface exposes
// no operation that creates or removes anything, so setup has to come from
// outside it. See e2e_harness_test.go for how those containers are marked and
// how the tests are kept away from everything else on the host.
package docker_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/compose"
	"github.com/dockplane/dockplane/agent/internal/docker"
)

const (
	testImage   = "busybox:latest"
	secretValue = "PLEASE-DO-NOT-TRANSMIT-THIS-VALUE"
)

func requireDocker(t *testing.T) *docker.Engine {
	t.Helper()

	engine, err := docker.Connect()

	if err != nil {
		t.Skipf("no Docker daemon available: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if _, err := engine.Version(ctx); err != nil {
		t.Skipf("no Docker daemon available: %v", err)
	}

	return engine
}

// startTestContainer runs a container carrying a deliberately secret-looking
// environment variable, Compose labels and a non-Compose label.
func startTestContainer(t *testing.T) (string, string) {
	t.Helper()

	return createContainer(t, "discovery",
		"--env", "DOCKPLANE_TEST_SECRET="+secretValue,
		"--label", "com.docker.compose.project=dockplane-test",
		"--label", "com.docker.compose.service=sleeper",
		"--label", "internal.deploy.token="+secretValue,
	)
}

func TestDiscoveryFindsARunningContainer(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name, id := startTestContainer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	containers, err := engine.ListContainers(ctx)

	if err != nil {
		t.Fatalf("list: %v", err)
	}

	var found *docker.ContainerSummary

	for index := range containers {
		if containers[index].Name == name {
			found = &containers[index]
		}
	}

	if found == nil {
		t.Fatalf("the test container %s was not discovered", name)
	}

	if found.State != "running" {
		t.Errorf("state = %q, want running", found.State)
	}

	if !strings.HasPrefix(id, found.DockerID) && !strings.HasPrefix(found.DockerID, id[:12]) {
		t.Errorf("docker id = %q, want the started container %q", found.DockerID, id)
	}

	if _, present := found.Labels["internal.deploy.token"]; present {
		t.Error("a non-Compose label reached the summary")
	}
}

func TestInspectDoesNotTransmitEnvironmentValues(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	name, _ := startTestContainer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	detail, err := engine.InspectContainer(ctx, name)

	if err != nil {
		t.Fatalf("inspect: %v", err)
	}

	encoded, err := json.Marshal(detail)

	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if strings.Contains(string(encoded), secretValue) {
		t.Fatal("the inspect projection transmitted a container environment value")
	}

	if strings.Contains(string(encoded), "DOCKPLANE_TEST_SECRET") {
		t.Fatal("the inspect projection transmitted an environment variable name")
	}

	if detail.Name != name {
		t.Errorf("name = %q, want %q", detail.Name, name)
	}
}

func TestComposeDiscoveryGroupsByLabel(t *testing.T) {
	engine := requireDocker(t)
	defer engine.Close()

	startTestContainer(t)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	containers, err := engine.ListContainers(ctx)

	if err != nil {
		t.Fatalf("list: %v", err)
	}

	project := compose.Find(containers, "dockplane-test")

	if project == nil {
		t.Fatal("the labelled container was not grouped into its project")
	}

	if project.ServiceCount != 1 || project.RunningCount != 1 {
		t.Errorf("services = %d, running = %d, want 1 and 1",
			project.ServiceCount, project.RunningCount)
	}
}
