package capability_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/capability"
)

/*
What a deploy request may contain.

A stack plan reaches the agent as typed fields, not as a Compose file, so the
decoder is the whole of the remote surface: a service cannot ask for
`privileged` inside a stack any more than it can outside one, and there is no
YAML for it to hide in.

None of these reach Docker — they are refused while being read — so the registry
is built without an engine.
*/
func stackRegistry() *capability.Registry {
	registry := capability.New()
	capability.Register(registry, capability.Sources{})

	return registry
}

func deploy(t *testing.T, payload string) error {
	t.Helper()

	_, err := stackRegistry().Invoke(
		context.Background(),
		capability.StackDeploy,
		json.RawMessage(payload),
	)

	return err
}

func TestStackDeployIsRegistered(t *testing.T) {
	for _, name := range stackRegistry().Names() {
		if name == capability.StackDeploy {
			return
		}
	}

	t.Fatal("stack.deploy is not registered")
}

/*
A stack cannot ask for what a single container cannot.

Each of these is a real Compose key the product refuses. The control server
rejects the file that contains one; this is the second refusal, on the machine,
and it holds even if the server that sent the plan was wrong or replaced.
*/
func TestAStackCannotAskForWhatTheAgentDoesNotModel(t *testing.T) {
	service := func(extra string) string {
		return `{"plan":{"planVersion":1,"stackId":"s","revisionId":"r","projectName":"p",` +
			`"services":[{"serviceName":"web","containerId":"c","containerName":"p-web-1",` +
			`"spec":{"name":"p-web-1","image":"nginx",` + extra + `}}]}}`
	}

	payloads := map[string]string{
		"privileged":         service(`"privileged":true`),
		"raw binds":          service(`"binds":["/:/host"]`),
		"host network mode":  service(`"networkMode":"host"`),
		"added capabilities": service(`"capAdd":["SYS_ADMIN"]`),
		"devices":            service(`"devices":["/dev/sda"]`),
		"a whole HostConfig": service(`"HostConfig":{"Privileged":true}`),
		"an unknown service field": `{"plan":{"planVersion":1,"stackId":"s","revisionId":"r",` +
			`"services":[{"serviceName":"web","scale":4}]}}`,
		"an unknown plan field": `{"plan":{"planVersion":1,"stackId":"s","revisionId":"r","compose":"..."}}`,
		"an unknown top-level field": `{"plan":{"planVersion":1,"stackId":"s","revisionId":"r"},` +
			`"composeFile":"services:\n  web:\n    privileged: true\n"}`,
		"a Compose file instead of a plan": `{"composeFile":"services:\n  web:\n    image: nginx\n"}`,
	}

	for name, payload := range payloads {
		t.Run(name, func(t *testing.T) {
			if err := deploy(t, payload); !errors.Is(err, capability.ErrInvalidPayload) {
				t.Fatalf("error = %v, want ErrInvalidPayload", err)
			}
		})
	}
}

func TestAMalformedDeployPayloadIsRefused(t *testing.T) {
	if err := deploy(t, `{ this is not json`); !errors.Is(err, capability.ErrInvalidPayload) {
		t.Fatalf("error = %v, want ErrInvalidPayload", err)
	}
}

/*
The environment a stack carries is not quoted back.

A stack's variables are the ones most likely to be credentials, and a refusal
that named the offending value would put it in an action record and an audit
entry at once.
*/
func TestADeployRefusalDoesNotQuoteValues(t *testing.T) {
	canary := "s3cr3t-canary-value-do-not-log"

	payload := `{"plan":{"planVersion":1,"stackId":"s","revisionId":"r","projectName":"p",` +
		`"services":[{"serviceName":"web","containerId":"c","containerName":"p-web-1",` +
		`"spec":{"name":"p-web-1","image":"nginx","env":[{"key":"BAD KEY","value":"` + canary +
		`"}],"privileged":true}}]}}`

	err := deploy(t, payload)

	if err == nil {
		t.Fatal("the plan was accepted")
	}

	if strings.Contains(err.Error(), canary) {
		t.Fatalf("the refusal quoted the value: %v", err)
	}
}

/*
The codes a failed deployment is reported under.

A plan this build is too old to read and a plan describing something impossible
are different answers, and an operator is shown which of the two happened.
*/
func TestStackFailuresMapToCodesTheServerKnows(t *testing.T) {
	known := map[string]bool{
		"AGENT_CAPABILITY_UNSUPPORTED": true,
		"VALIDATION_FAILED":            true,
		"CONTAINER_NAME_IN_USE":        true,
	}

	for _, err := range []error{
		capability.ErrUnsupported,
		capability.ErrInvalidPayload,
		capability.ErrNameInUse,
	} {
		if code := capability.Code(err); !known[code] {
			t.Fatalf("%v maps to %q, which the server does not accept", err, code)
		}
	}
}
