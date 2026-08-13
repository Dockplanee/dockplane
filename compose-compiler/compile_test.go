package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

/*
What a Compose file is allowed to become.

Two things are being checked throughout. That the subset Dockplane supports is
translated faithfully — a port, a volume, an interpolated variable end up in the
plan meaning what they meant in the file. And that everything else is refused
rather than dropped, because a deployment missing a feature its author
configured is worse than one that never started.
*/

// Unmistakable if it ever escaped into an error, a diagnostic or a log.
const canary = "canary-compose-secret-1c0ffee"

func compile(t *testing.T, compose string, environment map[string]string) (*StackDeploymentPlan, []Problem) {
	t.Helper()

	return Compile(Request{
		ProtocolVersion: ProtocolVersion,
		ProjectName:     "shop",
		Compose:         compose,
		Environment:     environment,
	})
}

func mustCompile(t *testing.T, compose string, environment map[string]string) *StackDeploymentPlan {
	t.Helper()

	plan, problems := compile(t, compose, environment)

	if len(problems) > 0 {
		t.Fatalf("expected a plan, got %+v", problems)
	}

	return plan
}

/** The one problem for a path, so a test can say which. */
func problemAt(problems []Problem, path string) *Problem {
	for index := range problems {
		if problems[index].Path == path {
			return &problems[index]
		}
	}

	return nil
}

func refuses(t *testing.T, compose string, path string, code string) {
	t.Helper()

	_, problems := compile(t, compose, nil)

	problem := problemAt(problems, path)

	if problem == nil {
		t.Fatalf("%s was accepted; problems were %+v", path, problems)
	}

	if problem.Code != code {
		t.Errorf("%s reported %s, want %s", path, problem.Code, code)
	}

	if problem.Message == "" {
		t.Errorf("%s was refused without saying why", path)
	}
}

func TestMinimalServiceBecomesAPlan(t *testing.T) {
	plan := mustCompile(t, "services:\n  web:\n    image: nginx:1.27\n", nil)

	if plan.PlanVersion != PlanVersion {
		t.Errorf("plan version = %d", plan.PlanVersion)
	}

	if len(plan.Services) != 1 || plan.Services[0].ServiceName != "web" {
		t.Fatalf("services = %+v", plan.Services)
	}

	if plan.Services[0].Image != "nginx:1.27" {
		t.Errorf("image = %q", plan.Services[0].Image)
	}

	// Compose's own default, carried explicitly rather than left to whatever
	// reads the plan.
	if plan.Services[0].RestartPolicy != "no" {
		t.Errorf("restart = %q", plan.Services[0].RestartPolicy)
	}
}

func TestTwoServicesKeepTheirOwnConfiguration(t *testing.T) {
	plan := mustCompile(t, `
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
    depends_on:
      - api
  api:
    image: api:2
    restart: unless-stopped
`, nil)

	if len(plan.Services) != 2 {
		t.Fatalf("services = %d", len(plan.Services))
	}

	// Sorted, so the plan does not depend on map iteration.
	if plan.Services[0].ServiceName != "api" || plan.Services[1].ServiceName != "web" {
		t.Fatalf("order = %s, %s", plan.Services[0].ServiceName, plan.Services[1].ServiceName)
	}

	if plan.Services[0].RestartPolicy != "unless-stopped" {
		t.Errorf("api restart = %q", plan.Services[0].RestartPolicy)
	}

	if len(plan.Services[1].DependsOn) != 1 || plan.Services[1].DependsOn[0] != "api" {
		t.Errorf("web depends on %+v", plan.Services[1].DependsOn)
	}
}

func TestPortsAndMountsAreNormalised(t *testing.T) {
	plan := mustCompile(t, `
services:
  web:
    image: nginx:1.27
    ports:
      - "127.0.0.1:8443:443/tcp"
      - "53:53/udp"
    volumes:
      - app-data:/data
      - /srv/config:/etc/app:ro
volumes:
  app-data: {}
`, nil)

	ports := plan.Services[0].Ports

	if len(ports) != 2 {
		t.Fatalf("ports = %+v", ports)
	}

	if ports[0].HostIP != "127.0.0.1" || ports[0].HostPort != 8443 || ports[0].ContainerPort != 443 {
		t.Errorf("first port = %+v", ports[0])
	}

	if ports[1].Protocol != "udp" {
		t.Errorf("second port = %+v", ports[1])
	}

	mounts := plan.Services[0].Mounts

	if len(mounts) != 2 {
		t.Fatalf("mounts = %+v", mounts)
	}

	if mounts[0].Type != "volume" || mounts[0].Source != "app-data" {
		t.Errorf("first mount = %+v", mounts[0])
	}

	if mounts[1].Type != "bind" || !mounts[1].ReadOnly {
		t.Errorf("second mount = %+v", mounts[1])
	}
}

/*
Interpolation is compose-go's, not ours.

Dockplane does no string substitution of its own — the corners of the Compose
specification are exactly where a second implementation would differ from the
first.
*/
func TestInterpolation(t *testing.T) {
	plan := mustCompile(t, `
services:
  web:
    image: nginx:${TAG}
    environment:
      PLAIN: ${DB_USER}
      DEFAULTED: ${MISSING:-fallback}
      ESCAPED: $$NOT_A_VARIABLE
`, map[string]string{"TAG": "1.27", "DB_USER": "nextcloud"})

	if plan.Services[0].Image != "nginx:1.27" {
		t.Errorf("image = %q", plan.Services[0].Image)
	}

	values := map[string]string{}

	for _, entry := range plan.Services[0].Environment {
		values[entry.Key] = entry.Value
	}

	if values["PLAIN"] != "nextcloud" {
		t.Errorf("PLAIN = %q", values["PLAIN"])
	}

	if values["DEFAULTED"] != "fallback" {
		t.Errorf("DEFAULTED = %q", values["DEFAULTED"])
	}

	if values["ESCAPED"] != "$NOT_A_VARIABLE" {
		t.Errorf("ESCAPED = %q", values["ESCAPED"])
	}
}

func TestSecretValuesReachThePlanAndNothingElse(t *testing.T) {
	plan := mustCompile(t, `
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}
`, map[string]string{"DB_PASSWORD": canary})

	if plan.Services[0].Environment[0].Value != canary {
		t.Fatal("the value did not reach the plan, which is what the agent needs")
	}
}

/*
A variable a service needs and nobody supplied.

Compose leaves it unset. Dockplane refuses: a container that starts without a
credential its author listed fails later, somewhere harder to look at.
*/
func TestMissingVariableIsRefused(t *testing.T) {
	_, problems := compile(t, "services:\n  db:\n    image: postgres:17\n    environment:\n      - NEEDED\n", nil)

	problem := problemAt(problems, "services.db.environment.NEEDED")

	if problem == nil {
		t.Fatalf("a missing variable was accepted: %+v", problems)
	}

	if !strings.Contains(problem.Message, "NEEDED") {
		t.Errorf("the message does not name the variable: %q", problem.Message)
	}
}

func TestMalformedYamlIsRefused(t *testing.T) {
	_, problems := compile(t, "services:\n  web:\n  image: [unclosed\n", nil)

	if len(problems) == 0 || problems[0].Code != codeParse {
		t.Fatalf("problems = %+v", problems)
	}
}

func TestUnknownComposePropertyIsRefused(t *testing.T) {
	_, problems := compile(t, "services:\n  web:\n    image: nginx:1.27\n    not_a_compose_field: yes\n", nil)

	if len(problems) == 0 {
		t.Fatal("an unknown property was accepted")
	}
}

/*
Everything Dockplane does not do.

Refused with a path and a code, so an interface can point at the line and a
person can read why.
*/
func TestUnsupportedFeaturesAreRefused(t *testing.T) {
	for _, unsupported := range []struct {
		name    string
		compose string
		path    string
		code    string
	}{
		{
			"build",
			"services:\n  app:\n    build: .\n",
			"services.app.build",
			codeUnsupported,
		},
		{
			"deploy",
			"services:\n  app:\n    image: nginx\n    deploy:\n      replicas: 3\n",
			"services.app.deploy",
			codeUnsupported,
		},
		{
			"privileged",
			"services:\n  app:\n    image: nginx\n    privileged: true\n",
			"services.app.privileged",
			codeUnsupported,
		},
		{
			"capabilities",
			"services:\n  app:\n    image: nginx\n    cap_add: [SYS_ADMIN]\n",
			"services.app.cap_add",
			codeUnsupported,
		},
		{
			"devices",
			"services:\n  app:\n    image: nginx\n    devices: ['/dev/sda:/dev/sda']\n",
			"services.app.devices",
			codeUnsupported,
		},
		{
			"host pid",
			"services:\n  app:\n    image: nginx\n    pid: host\n",
			"services.app.pid",
			codeUnsupported,
		},
		{
			"host ipc",
			"services:\n  app:\n    image: nginx\n    ipc: host\n",
			"services.app.ipc",
			codeUnsupported,
		},
		{
			"network mode",
			"services:\n  app:\n    image: nginx\n    network_mode: host\n",
			"services.app.network_mode",
			codeUnsupported,
		},
		{
			"service configs",
			"services:\n  app:\n    image: nginx\n    configs: [conf]\nconfigs:\n  conf:\n    external: true\n",
			"services.app.configs",
			codeUnsupported,
		},
		{
			"service secrets",
			"services:\n  app:\n    image: nginx\n    secrets: [token]\nsecrets:\n  token:\n    external: true\n",
			"services.app.secrets",
			codeUnsupported,
		},
		{
			"a dependency condition nothing implements",
			"services:\n  app:\n    image: nginx\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres\n",
			"services.app.depends_on.db.condition",
			codeUnsupported,
		},
		{
			"a port range",
			"services:\n  app:\n    image: nginx\n    ports: ['8000-8010:80']\n",
			"services.app.ports[0]",
			codeUnsupported,
		},
		{
			"a restart policy Dockplane does not apply",
			"services:\n  app:\n    image: nginx\n    restart: on-failure:5\n",
			"services.app.restart",
			codeUnsupported,
		},
	} {
		t.Run(unsupported.name, func(t *testing.T) {
			refuses(t, unsupported.compose, unsupported.path, unsupported.code)
		})
	}
}

func TestExtendsAndIncludeAreRefused(t *testing.T) {
	// Both reach for another file. Neither is supported, and the loader is told
	// not to follow them either.
	for _, compose := range []string{
		"services:\n  app:\n    extends:\n      file: other.yaml\n      service: base\n",
		"include:\n  - other.yaml\nservices:\n  app:\n    image: nginx\n",
	} {
		if _, problems := compile(t, compose, nil); len(problems) == 0 {
			t.Errorf("accepted: %s", compose)
		}
	}
}

func TestReservedLabelIsRefused(t *testing.T) {
	refuses(
		t,
		"services:\n  app:\n    image: nginx\n    labels:\n      io.dockplane.container-id: mine\n",
		"services.app.labels.io.dockplane.container-id",
		codeReserved,
	)
}

func TestDangerousBindsAreRefused(t *testing.T) {
	for _, source := range []string{"/var/run/docker.sock", "/proc", "/", "/var/lib/dockplane-agent/state"} {
		compose := "services:\n  app:\n    image: nginx\n    volumes:\n      - " + source + ":/mnt\n"

		_, problems := compile(t, compose, nil)

		if problemAt(problems, "services.app.volumes[0]") == nil {
			t.Errorf("%s was accepted: %+v", source, problems)
		}
	}
}

func TestInvalidProjectNameIsRefused(t *testing.T) {
	_, problems := Compile(Request{
		ProtocolVersion: ProtocolVersion,
		ProjectName:     "Not A Project",
		Compose:         "services:\n  app:\n    image: nginx\n",
	})

	if problemAt(problems, "projectName") == nil {
		t.Fatalf("problems = %+v", problems)
	}
}

func TestLimits(t *testing.T) {
	t.Run("compose too large", func(t *testing.T) {
		_, problems := compile(t, strings.Repeat("# padding\n", maxComposeBytes), nil)

		if problemAt(problems, "compose") == nil {
			t.Fatalf("problems = %+v", problems)
		}
	})

	t.Run("too many services", func(t *testing.T) {
		compose := "services:\n"

		for index := 0; index <= maxServices; index++ {
			compose += "  s" + string(rune('a'+index%26)) + itoa(index) + ":\n    image: nginx\n"
		}

		_, problems := compile(t, compose, nil)

		if problemAt(problems, "services") == nil {
			t.Fatalf("problems = %+v", problems)
		}
	})

	t.Run("too many variables", func(t *testing.T) {
		environment := map[string]string{}

		for index := 0; index <= maxEnvironment; index++ {
			environment["V"+itoa(index)] = "x"
		}

		_, problems := compile(t, "services:\n  app:\n    image: nginx\n", environment)

		if problemAt(problems, "environment") == nil {
			t.Fatalf("problems = %+v", problems)
		}
	})
}

/*
The same file, the same plan.

Compose is a map and Go iterates maps in no particular order, so this is the
difference between a stack revision that shows a real change and one that looks
different every time it is compiled.
*/
func TestPlanIsDeterministic(t *testing.T) {
	compose := `
services:
  web:
    image: nginx:1.27
    environment:
      B: two
      A: one
      C: three
    labels:
      z: last
      a: first
    networks: [back, front]
  api:
    image: api:2
    networks: [front]
networks:
  front: {}
  back: {}
`

	first := encode(t, mustCompile(t, compose, nil))

	for attempt := 0; attempt < 5; attempt++ {
		if again := encode(t, mustCompile(t, compose, nil)); again != first {
			t.Fatalf("compiling twice produced different plans:\n%s\n%s", first, again)
		}
	}
}

func encode(t *testing.T, plan *StackDeploymentPlan) string {
	t.Helper()

	encoded, err := json.Marshal(plan)

	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	return string(encoded)
}

/*
What the outside sees when something goes wrong.

The request carried a secret, so every path out of this process is checked: the
answer on standard output, and the diagnostics on standard error.
*/
func TestNoSecretEscapesOnFailure(t *testing.T) {
	for _, broken := range []string{
		// Fails while interpolating, with the value already in hand.
		"services:\n  app:\n    image: ${TAG}\n    privileged: true\n",
		// Fails to parse, after the environment was read.
		"services:\n  app:\n    image: [unclosed\n",
		// Fails validation on a value that was interpolated from the secret.
		"services:\n  app:\n    image: nginx\n    labels:\n      io.dockplane.x: ${DB_PASSWORD}\n",
	} {
		request := Request{
			ProtocolVersion: ProtocolVersion,
			ProjectName:     "shop",
			Compose:         broken,
			Environment:     map[string]string{"DB_PASSWORD": canary, "TAG": canary},
		}

		encoded, err := json.Marshal(request)

		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var stdout, stderr bytes.Buffer

		run(bytes.NewReader(encoded), &stdout, &stderr)

		if strings.Contains(stdout.String(), canary) {
			t.Errorf("a secret reached the answer for:\n%s\n%s", broken, stdout.String())
		}

		if strings.Contains(stderr.String(), canary) {
			t.Errorf("a secret reached the diagnostics for:\n%s\n%s", broken, stderr.String())
		}
	}
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}

	digits := ""

	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}

	return digits
}

/*
Every service comes out with the name Docker will know it by.

Compose's own default where the file did not ask for one, so that the thing
deploying a plan never has to know how Compose names containers — and so that a
service which does ask keeps the name its author chose.
*/
func TestEveryServiceIsGivenAContainerName(t *testing.T) {
	plan := mustCompile(t, `
services:
  web:
    image: nginx
  database:
    image: postgres
    container_name: shop-db
`, nil)

	names := map[string]string{}

	for _, service := range plan.Services {
		names[service.ServiceName] = service.ContainerName
	}

	if names["web"] != "shop-web-1" {
		t.Errorf("web = %q, want shop-web-1", names["web"])
	}

	if names["database"] != "shop-db" {
		t.Errorf("database = %q, want the name the file asked for", names["database"])
	}
}
