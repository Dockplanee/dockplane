package docker_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"syscall"
	"testing"
	"time"

	dockertypes "github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	dockersystem "github.com/docker/docker/api/types/system"
	"github.com/docker/go-connections/nat"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

// fakeClient stands in for the Docker Engine. The agent's own client interface
// is deliberately small enough that a substitute cannot express a mutation.
type fakeClient struct {
	summaries  []container.Summary
	inspect    container.InspectResponse
	listErr    error
	inspectErr error

	/** Every lifecycle call this client received, in order. */
	calls      []string
	startErr   error
	stopErr    error
	restartErr error

	/** What a log read returns, and the options it was asked for. */
	logs        func() io.ReadCloser
	logsErr     error
	logsOptions container.LogsOptions
}

func (f *fakeClient) ContainerList(context.Context, container.ListOptions) ([]container.Summary, error) {
	return f.summaries, f.listErr
}

func (f *fakeClient) ContainerInspect(context.Context, string) (container.InspectResponse, error) {
	return f.inspect, f.inspectErr
}

func (f *fakeClient) ContainerLogs(
	_ context.Context,
	id string,
	options container.LogsOptions,
) (io.ReadCloser, error) {
	f.calls = append(f.calls, "logs:"+id)
	f.logsOptions = options

	if f.logsErr != nil {
		return nil, f.logsErr
	}

	if f.logs == nil {
		return io.NopCloser(strings.NewReader("")), nil
	}

	return f.logs(), nil
}

func (f *fakeClient) ContainerStart(_ context.Context, id string, _ container.StartOptions) error {
	f.calls = append(f.calls, "start:"+id)
	return f.startErr
}

func (f *fakeClient) ContainerStop(_ context.Context, id string, options container.StopOptions) error {
	f.calls = append(f.calls, fmt.Sprintf("stop:%s:%d", id, timeoutOf(options)))
	return f.stopErr
}

func (f *fakeClient) ContainerRestart(
	_ context.Context,
	id string,
	options container.StopOptions,
) error {
	f.calls = append(f.calls, fmt.Sprintf("restart:%s:%d", id, timeoutOf(options)))
	return f.restartErr
}

func timeoutOf(options container.StopOptions) int {
	if options.Timeout == nil {
		return -1
	}

	return *options.Timeout
}

func (f *fakeClient) Info(context.Context) (dockersystem.Info, error) {
	return dockersystem.Info{}, nil
}

func (f *fakeClient) ServerVersion(context.Context) (dockertypes.Version, error) {
	return dockertypes.Version{Version: "29.0.0"}, nil
}

func (f *fakeClient) Close() error { return nil }

func TestListContainersNormalisesTheSummary(t *testing.T) {
	engine := docker.NewEngine(&fakeClient{summaries: []container.Summary{{
		ID:      "abc123",
		Names:   []string{"/web", "/web-alias"},
		Image:   "nginx:1.27",
		ImageID: "sha256:deadbeef",
		State:   "running",
		Status:  "Up 2 hours (healthy)",
		Created: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC).Unix(),
		Labels: map[string]string{
			"com.docker.compose.project": "shop",
			"com.docker.compose.service": "web",
			"internal.deploy.token":      "s3cr3t",
		},
	}}})

	result, err := engine.ListContainers(context.Background())

	if err != nil {
		t.Fatalf("list: %v", err)
	}

	if len(result) != 1 {
		t.Fatalf("got %d containers, want 1", len(result))
	}

	item := result[0]

	if item.Name != "web" {
		t.Errorf("name = %q, want web", item.Name)
	}

	if item.Health != "healthy" {
		t.Errorf("health = %q, want healthy", item.Health)
	}

	if item.Labels["com.docker.compose.project"] != "shop" {
		t.Error("the Compose project label was not kept")
	}

	if _, present := item.Labels["internal.deploy.token"]; present {
		t.Error("a non-Compose label was forwarded")
	}
}

/*
Exactly which labels leave the host, named one by one.

A label the control server reads has to be one it asked for. Docker labels are
writable by anyone who can reach the daemon, so an allow list that grew by
accident would be a way to put chosen values into the control server's own
records — and the identity labels among these are what discovery matches
containers to resources by.

Written as an exact set rather than a set of individual checks, so widening it
is a decision somebody makes here rather than a side effect somewhere else.
*/
func TestForwardedLabelsAreExactlyTheOnesTheServerReads(t *testing.T) {
	offered := map[string]string{
		"com.docker.compose.project":          "shop",
		"com.docker.compose.service":          "web",
		"com.docker.compose.container-number": "1",
		"com.docker.compose.oneoff":           "False",
		docker.LabelManaged:                   "true",
		docker.LabelContainerID:               "container-x",
		docker.LabelDesiredConfigID:           "config-a",

		// Everything else, however plausible it looks.
		docker.LabelStack:            "billing",
		"com.docker.compose.version": "2.31.0",
		"io.dockplane.anything":      "no",
		"maintainer":                 "somebody",
		"internal.deploy.token":      "s3cr3t",
	}

	expected := []string{
		"com.docker.compose.project",
		"com.docker.compose.service",
		"com.docker.compose.container-number",
		"com.docker.compose.oneoff",
		docker.LabelManaged,
		docker.LabelContainerID,
		docker.LabelDesiredConfigID,
	}

	engine := docker.NewEngine(&fakeClient{summaries: []container.Summary{{
		ID: "abc123", Names: []string{"/web"}, Image: "nginx:1.27", State: "running", Labels: offered,
	}}})

	result, err := engine.ListContainers(context.Background())

	if err != nil {
		t.Fatalf("list: %v", err)
	}

	forwarded := result[0].Labels

	if len(forwarded) != len(expected) {
		t.Fatalf("forwarded %d labels, want %d: %v", len(forwarded), len(expected), forwarded)
	}

	for _, key := range expected {
		if forwarded[key] != offered[key] {
			t.Errorf("%s = %q, want %q", key, forwarded[key], offered[key])
		}
	}
}

func TestInspectOmitsEnvironmentAndOtherSensitiveDetail(t *testing.T) {
	pidsLimit := int64(100)

	engine := docker.NewEngine(&fakeClient{inspect: container.InspectResponse{
		ContainerJSONBase: &container.ContainerJSONBase{
			ID:           "abc123",
			Name:         "/db",
			Image:        "sha256:cafebabe",
			Created:      "2026-01-02T03:04:05.000000000Z",
			RestartCount: 3,
			State: &container.State{
				Status:  "running",
				Running: true,
				Health:  &container.Health{Status: "healthy"},
			},
			HostConfig: &container.HostConfig{
				RestartPolicy: container.RestartPolicy{Name: "unless-stopped"},
				Resources: container.Resources{
					Memory:    2 << 30,
					NanoCPUs:  1_500_000_000,
					PidsLimit: &pidsLimit,
				},
			},
		},
		Config: &container.Config{
			Image: "postgres:17",
			Env: []string{
				"POSTGRES_PASSWORD=super-secret-value",
				"AWS_SECRET_ACCESS_KEY=another-secret",
			},
			Cmd:        []string{"postgres", "-c", "password_encryption=scram-sha-256"},
			Entrypoint: []string{"/usr/local/bin/docker-entrypoint.sh"},
			Labels: map[string]string{
				"com.docker.compose.project": "shop",
				"com.docker.compose.service": "db",
			},
		},
		NetworkSettings: &container.NetworkSettings{
			NetworkSettingsBase: container.NetworkSettingsBase{
				Ports: nat.PortMap{
					"5432/tcp": []nat.PortBinding{{HostIP: "127.0.0.1", HostPort: "5433"}},
				},
			},
			Networks: map[string]*network.EndpointSettings{"shop_default": {}},
		},
		Mounts: []container.MountPoint{
			{Type: mount.TypeVolume, Name: "shop_pgdata", RW: true},
			{Type: mount.TypeBind, Source: "/home/operator/secrets", Destination: "/run/secrets", RW: false},
		},
	}})

	detail, err := engine.InspectContainer(context.Background(), "abc123")

	if err != nil {
		t.Fatalf("inspect: %v", err)
	}

	encoded, err := json.Marshal(detail)

	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	serialised := string(encoded)

	for _, forbidden := range []string{
		"super-secret-value",
		"AWS_SECRET_ACCESS_KEY",
		"another-secret",
		"password_encryption",
		"docker-entrypoint.sh",
		"/home/operator/secrets",
	} {
		if strings.Contains(serialised, forbidden) {
			t.Errorf("the inspect projection leaked %q", forbidden)
		}
	}

	if detail.RestartPolicy != "unless-stopped" {
		t.Errorf("restart policy = %q", detail.RestartPolicy)
	}

	if len(detail.Ports) != 1 || detail.Ports[0].HostPort != "5433" {
		t.Errorf("ports = %+v", detail.Ports)
	}

	if len(detail.Networks) != 1 || detail.Networks[0] != "shop_default" {
		t.Errorf("networks = %+v", detail.Networks)
	}

	if detail.Limits == nil || detail.Limits.PidsLimit != 100 {
		t.Errorf("limits = %+v", detail.Limits)
	}

	var namedVolume, bind *docker.Mount

	for index := range detail.Mounts {
		switch detail.Mounts[index].Type {
		case "volume":
			namedVolume = &detail.Mounts[index]
		case "bind":
			bind = &detail.Mounts[index]
		}
	}

	if namedVolume == nil || namedVolume.Name != "shop_pgdata" {
		t.Errorf("named volume = %+v", namedVolume)
	}

	if bind == nil {
		t.Fatal("the bind mount was dropped entirely; its presence is operational information")
	}

	if bind.Name != "" {
		t.Errorf("the bind mount reported a source path: %q", bind.Name)
	}
}

func TestDockerUnavailableIsReportedNotFatal(t *testing.T) {
	engine := docker.NewEngine(&fakeClient{listErr: errors.New("cannot connect to the Docker daemon")})

	_, err := engine.ListContainers(context.Background())

	if !errors.Is(err, docker.ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func TestPermissionDeniedIsReportedAsUnavailable(t *testing.T) {
	engine := docker.NewEngine(&fakeClient{
		listErr: errors.New("dial unix /var/run/docker.sock: connect: permission denied"),
	})

	_, err := engine.ListContainers(context.Background())

	if !errors.Is(err, docker.ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

/*
A socket the agent may not open is named as a permission problem.

The Docker client reports it as a connection failure, so a naive classification
tells an operator the daemon is down and sends them to restart Docker when the
service account simply needs the docker group.
*/
func TestPermissionDeniedIsNamedAsPermission(t *testing.T) {
	for _, failure := range []error{
		errors.New("Cannot connect to the Docker daemon at unix:///var/run/docker.sock: permission denied"),
		fmt.Errorf("dial unix /var/run/docker.sock: connect: %w", syscall.EACCES),
	} {
		engine := docker.NewEngine(&fakeClient{listErr: failure})

		_, err := engine.ListContainers(context.Background())

		if !errors.Is(err, docker.ErrUnavailable) {
			t.Fatalf("error = %v, want ErrUnavailable", err)
		}

		if !strings.Contains(err.Error(), "not permitted") {
			t.Errorf("error = %q, want it to say the agent is not permitted", err)
		}

		if !strings.Contains(err.Error(), "docker group") {
			t.Errorf("error = %q, want it to name the fix", err)
		}
	}
}
