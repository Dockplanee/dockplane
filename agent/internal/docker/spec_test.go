package docker

import (
	"errors"
	"strings"
	"testing"
)

// A specification that is entirely ordinary, which each test then spoils in one
// specific way.
func validSpec() ContainerSpec {
	return ContainerSpec{
		Name:  "web",
		Image: "nginx:1.27-alpine",
		Env: []EnvVar{
			{Key: "APP_ENV", Value: "production"},
		},
		Ports: []PortSpec{
			{ContainerPort: 80, HostPort: 8080, Protocol: "tcp"},
		},
		Mounts: []MountSpec{
			{Type: "volume", Source: "web-data", Target: "/data"},
		},
		Networks:      []string{"dockplane"},
		RestartPolicy: "unless-stopped",
		Labels:        map[string]string{"com.example.team": "platform"},
	}
}

func TestValidSpecIsAccepted(t *testing.T) {
	spec := validSpec()

	if err := spec.Validate(); err != nil {
		t.Fatalf("a valid specification was refused: %v", err)
	}
}

/*
The refusals.

Each of these is something a caller could ask for and the agent will not build.
The point is not that the server would also refuse it — the point is that this
holds when the server is wrong.
*/
func TestSpecRefusals(t *testing.T) {
	cases := []struct {
		name   string
		spoil  func(*ContainerSpec)
		reason string
	}{
		{"an empty name", func(s *ContainerSpec) { s.Name = "" }, "name"},
		{"a name with a slash", func(s *ContainerSpec) { s.Name = "web/proxy" }, "name"},
		{"a name with a space", func(s *ContainerSpec) { s.Name = "web proxy" }, "name"},
		{"an empty image", func(s *ContainerSpec) { s.Image = "" }, "image"},
		{
			"an image reference carrying a shell command",
			func(s *ContainerSpec) { s.Image = "nginx; rm -rf /" },
			"image",
		},
		{
			"an image reference with a newline",
			func(s *ContainerSpec) { s.Image = "nginx\nFROM scratch" },
			"image",
		},
		{
			"an unknown restart policy",
			func(s *ContainerSpec) { s.RestartPolicy = "sometimes" },
			"restartPolicy",
		},
		{
			"an environment key that is not one",
			func(s *ContainerSpec) { s.Env = []EnvVar{{Key: "not a key", Value: "x"}} },
			"environment key",
		},
		{
			"an environment key smuggling a second assignment",
			func(s *ContainerSpec) { s.Env = []EnvVar{{Key: "A=B", Value: "x"}} },
			"environment key",
		},
		{
			"an environment value with a newline",
			func(s *ContainerSpec) { s.Env = []EnvVar{{Key: "A", Value: "one\nTWO=two"}} },
			"environment value",
		},
		{
			"the same environment key twice",
			func(s *ContainerSpec) {
				s.Env = []EnvVar{{Key: "A", Value: "1"}, {Key: "A", Value: "2"}}
			},
			"given twice",
		},
		{
			"a protocol that is not tcp or udp",
			func(s *ContainerSpec) { s.Ports[0].Protocol = "sctp" },
			"protocol",
		},
		{
			"a container port of zero",
			func(s *ContainerSpec) { s.Ports[0].ContainerPort = 0 },
			"container port",
		},
		{
			"one host port bound twice",
			func(s *ContainerSpec) {
				s.Ports = []PortSpec{
					{ContainerPort: 80, HostPort: 8080, Protocol: "tcp"},
					{ContainerPort: 81, HostPort: 8080, Protocol: "tcp"},
				}
			},
			"bound twice",
		},
		{
			"a bind address that is not one",
			func(s *ContainerSpec) { s.Ports[0].HostIP = "evil.example" },
			"bind address",
		},
		{
			"a mount target that is relative",
			func(s *ContainerSpec) { s.Mounts[0].Target = "data" },
			"mount target",
		},
		{
			"a mount target climbing out",
			func(s *ContainerSpec) { s.Mounts[0].Target = "/data/../../etc" },
			"mount target",
		},
		{
			"one target mounted twice",
			func(s *ContainerSpec) {
				s.Mounts = []MountSpec{
					{Type: "volume", Source: "a", Target: "/data"},
					{Type: "volume", Source: "b", Target: "/data"},
				}
			},
			"used twice",
		},
		{
			"a mount type that is neither",
			func(s *ContainerSpec) { s.Mounts[0].Type = "tmpfs" },
			"mount type",
		},
		{
			"a volume name that is not one",
			func(s *ContainerSpec) { s.Mounts[0].Source = "../../etc" },
			"volume name",
		},
		{
			"a relative bind source",
			func(s *ContainerSpec) {
				s.Mounts[0] = MountSpec{Type: "bind", Source: "etc", Target: "/etc"}
			},
			"absolute path",
		},
		{
			"a bind source climbing out",
			func(s *ContainerSpec) {
				s.Mounts[0] = MountSpec{Type: "bind", Source: "/srv/../etc", Target: "/etc"}
			},
			"absolute path",
		},
		{
			"the root filesystem as a bind source",
			func(s *ContainerSpec) {
				s.Mounts[0] = MountSpec{Type: "bind", Source: "/", Target: "/host"}
			},
			"root filesystem",
		},
		{
			"a network name that is not one",
			func(s *ContainerSpec) { s.Networks = []string{"net work"} },
			"network",
		},
		{
			"a label key that is not one",
			func(s *ContainerSpec) { s.Labels = map[string]string{"bad key": "x"} },
			"label",
		},
		{
			"a healthcheck with nothing to run",
			func(s *ContainerSpec) { s.Healthcheck = &HealthcheckSpec{} },
			"healthcheck",
		},
		{
			"a hostname that is not one",
			func(s *ContainerSpec) { s.Hostname = "not a hostname" },
			"hostname",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			spec := validSpec()
			testCase.spoil(&spec)

			err := spec.Validate()

			if err == nil {
				t.Fatalf("accepted %s", testCase.name)
			}

			if !errors.Is(err, ErrInvalidSpec) {
				t.Fatalf("refused for the wrong reason: %v", err)
			}

			if !strings.Contains(err.Error(), testCase.reason) {
				t.Fatalf("expected the message to mention %q, got %q", testCase.reason, err)
			}
		})
	}
}

/*
Handing out the host.

Mounting the Docker socket into a container is how a container escape is
normally written, and the agent already holds that socket. These are the paths
it will not lend.
*/
func TestBindSourcesThatWouldHandOverTheHost(t *testing.T) {
	forbidden := []string{
		"/var/run/docker.sock",
		"/run/docker.sock",
		"/var/run/docker.sock/",
		"/var/lib/docker",
		"/var/lib/docker/volumes",
		"/proc",
		"/proc/self",
		"/sys",
		"/sys/fs/cgroup",
		"/dev",
		"/dev/mem",
		"/boot",
		"/etc/shadow",
		"/root/.ssh",
		"/root/.ssh/id_ed25519",
		"/var/lib/dockplane-agent",
		"/var/lib/dockplane-agent/agent.key",
	}

	for _, source := range forbidden {
		t.Run(source, func(t *testing.T) {
			spec := validSpec()
			spec.Mounts = []MountSpec{{Type: "bind", Source: source, Target: "/mnt"}}

			if err := spec.Validate(); err == nil {
				t.Fatalf("accepted a bind mount of %s", source)
			}
		})
	}
}

func TestOrdinaryBindSourcesAreAllowed(t *testing.T) {
	// The forbidden list is a floor, not a cage. Bind mounts are a normal thing
	// to want, and refusing all of them would make the feature useless.
	allowed := []string{"/srv/app", "/opt/data", "/home/deploy/site", "/mnt/storage"}

	for _, source := range allowed {
		t.Run(source, func(t *testing.T) {
			spec := validSpec()
			spec.Mounts = []MountSpec{{Type: "bind", Source: source, Target: "/mnt"}}

			if err := spec.Validate(); err != nil {
				t.Fatalf("refused an ordinary bind mount of %s: %v", source, err)
			}
		})
	}
}

func TestAgentLabelsCannotBeClaimedByTheCaller(t *testing.T) {
	spec := validSpec()
	// Validation refuses these outright; this checks the applied set as well,
	// so a reserved key can never survive even if validation were bypassed.
	spec.Labels = map[string]string{
		LabelManaged:      "false",
		LabelStack:        "somebody-elses-stack",
		"com.example.own": "kept",
	}

	labels := spec.LabelSet("", "", "")

	if labels[LabelManaged] != "true" {
		t.Fatalf("a caller overrode the managed label: %q", labels[LabelManaged])
	}

	if _, present := labels[LabelStack]; present {
		t.Fatalf("a caller claimed a stack it was not deployed by: %q", labels[LabelStack])
	}

	if labels["com.example.own"] != "kept" {
		t.Fatal("the caller's own labels were discarded")
	}
}

func TestStackLabelIsAppliedWhenDeployedByOne(t *testing.T) {
	spec := validSpec()
	labels := spec.LabelSet("billing", "", "")

	if labels[LabelStack] != "billing" {
		t.Fatalf("stack label is %q", labels[LabelStack])
	}
}

func TestEnvironmentIsRenderedInAStableOrder(t *testing.T) {
	spec := validSpec()
	spec.Env = []EnvVar{
		{Key: "ZULU", Value: "1"},
		{Key: "ALPHA", Value: "2"},
		{Key: "MIKE", Value: "3"},
	}

	rendered := spec.SortedEnv()
	expected := []string{"ALPHA=2", "MIKE=3", "ZULU=1"}

	for index, want := range expected {
		if rendered[index] != want {
			t.Fatalf("position %d is %q, expected %q", index, rendered[index], want)
		}
	}
}
