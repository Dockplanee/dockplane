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
What the management capabilities refuse before they reach Docker.

The decoder is the boundary. A request carrying a field the agent does not model
is not a request it understands, and answering it as though the extra field were
absent would tell the caller it had been accepted — which for a field like
`privileged` or `binds` would be a lie with consequences.

None of these reach an engine, so the registry is built without one.
*/
func managementRegistry() *capability.Registry {
	registry := capability.New()
	capability.Register(registry, capability.Sources{})

	return registry
}

func TestManagementCapabilitiesAreRegistered(t *testing.T) {
	names := managementRegistry().Names()
	present := make(map[string]bool, len(names))

	for _, name := range names {
		present[name] = true
	}

	for _, wanted := range []string{"container.create", "container.replace", "container.remove"} {
		if !present[wanted] {
			t.Fatalf("%s is not registered", wanted)
		}
	}
}

/*
Fields the agent does not model.

Each of these is a real Docker option, and each would widen the remote surface
to something the product has decided not to have. They are refused because the
decoder refuses what it cannot name, not because they appear on a list.
*/
func TestDockerOptionsTheAgentDoesNotModelAreRefused(t *testing.T) {
	registry := managementRegistry()

	payloads := map[string]string{
		"privileged":                 `{"spec":{"name":"a","image":"b","privileged":true}}`,
		"raw binds":                  `{"spec":{"name":"a","image":"b","binds":["/:/host"]}}`,
		"host network mode":          `{"spec":{"name":"a","image":"b","networkMode":"host"}}`,
		"pid namespace":              `{"spec":{"name":"a","image":"b","pidMode":"host"}}`,
		"added capabilities":         `{"spec":{"name":"a","image":"b","capAdd":["SYS_ADMIN"]}}`,
		"devices":                    `{"spec":{"name":"a","image":"b","devices":["/dev/sda"]}}`,
		"a whole HostConfig":         `{"spec":{"name":"a","image":"b","HostConfig":{"Privileged":true}}}`,
		"an unknown top-level field": `{"spec":{"name":"a","image":"b"},"command":"rm -rf /"}`,
	}

	for name, payload := range payloads {
		t.Run(name, func(t *testing.T) {
			_, err := registry.Invoke(
				context.Background(),
				capability.ContainerCreate,
				json.RawMessage(payload),
			)

			if !errors.Is(err, capability.ErrInvalidPayload) {
				t.Fatalf("error = %v, want ErrInvalidPayload", err)
			}
		})
	}
}

func TestReplaceRefusesAnIdentifierThatIsNotOne(t *testing.T) {
	registry := managementRegistry()

	for _, bad := range []string{
		`{"dockerId":"; rm -rf /","spec":{"name":"a","image":"b"}}`,
		`{"dockerId":"$(whoami)","spec":{"name":"a","image":"b"}}`,
		`{"dockerId":"","spec":{"name":"a","image":"b"}}`,
		`{"dockerId":"../../etc/passwd","spec":{"name":"a","image":"b"}}`,
		`{"spec":{"name":"a","image":"b"}}`,
	} {
		_, err := registry.Invoke(context.Background(), capability.ContainerReplace, json.RawMessage(bad))

		if !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", bad, err)
		}
	}
}

func TestRemoveRefusesAnIdentifierThatIsNotOne(t *testing.T) {
	registry := managementRegistry()

	for _, bad := range []string{
		`{"dockerId":"; docker rm -f dockplane-api-1"}`,
		`{"dockerId":""}`,
		`{}`,
		`{"dockerId":"aaa111","removeVolumes":true}`,
	} {
		_, err := registry.Invoke(context.Background(), capability.ContainerRemove, json.RawMessage(bad))

		if !errors.Is(err, capability.ErrInvalidPayload) {
			t.Errorf("%s: error = %v, want ErrInvalidPayload", bad, err)
		}
	}
}

/*
Removing volumes is not something a request can ask for.

Docker's remove takes a flag that deletes the container's volumes with it. The
agent does not model that flag, so there is no field to set: a request that
tries is refused rather than quietly having its wish ignored, which is the
difference between a caller learning it cannot delete data and a caller
believing it did.
*/
func TestVolumeRemovalCannotBeRequested(t *testing.T) {
	registry := managementRegistry()

	for _, attempt := range []string{
		`{"dockerId":"aaa111","removeVolumes":true}`,
		`{"dockerId":"aaa111","v":true}`,
		`{"dockerId":"aaa111","force":true,"removeVolumes":true}`,
	} {
		_, err := registry.Invoke(context.Background(), capability.ContainerRemove, json.RawMessage(attempt))

		if !errors.Is(err, capability.ErrInvalidPayload) {
			t.Fatalf("%s was not refused: %v", attempt, err)
		}
	}
}

func TestReservedLabelsCannotBeSetByACaller(t *testing.T) {
	registry := managementRegistry()

	for _, reserved := range []string{
		"io.dockplane.managed", "io.dockplane.container-id", "io.dockplane.stack",
	} {
		t.Run(reserved, func(t *testing.T) {
			payload := `{"spec":{"name":"a","image":"b","labels":{"` + reserved + `":"mine"}}}`

			_, err := registry.Invoke(
				context.Background(),
				capability.ContainerCreate,
				json.RawMessage(payload),
			)

			if err == nil {
				t.Fatalf("a caller set %s", reserved)
			}
		})
	}
}

func TestMalformedPayloadIsRefused(t *testing.T) {
	registry := managementRegistry()

	for _, name := range []string{
		capability.ContainerCreate,
		capability.ContainerReplace,
		capability.ContainerRemove,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := registry.Invoke(context.Background(), name, json.RawMessage(`{ this is not json`))

			if !errors.Is(err, capability.ErrInvalidPayload) {
				t.Fatalf("error = %v, want ErrInvalidPayload", err)
			}
		})
	}
}

/*
The codes the control server is allowed to receive.

An agent names a failure from the server's list and nothing else, so a new
error that maps to nothing would arrive as a generic failure and an operator
would be told less than the agent knew.
*/
func TestManagementErrorsMapToCodesTheServerKnows(t *testing.T) {
	known := map[string]bool{
		"CONTAINER_NAME_IN_USE":  true,
		"IMAGE_NOT_FOUND":        true,
		"INVALID_CONTAINER_SPEC": true,
		"REPLACEMENT_FAILED":     true,
	}

	for _, err := range []error{
		capability.ErrNameInUse,
		capability.ErrImageNotFound,
		capability.ErrInvalidSpec,
		capability.ErrReplacementFailed,
	} {
		code := capability.Code(err)

		if !known[code] {
			t.Fatalf("%v maps to %q, which the server does not accept", err, code)
		}
	}
}

/*
The words a failure is reported in never carry a value.

An environment value can be a credential, and a message that quoted the
offending one would put it in an action record, an audit entry and an operator's
screen at once.
*/
func TestRefusalsDoNotQuoteValues(t *testing.T) {
	registry := managementRegistry()
	canary := "s3cr3t-canary-value-do-not-log"

	payload := `{"spec":{"name":"a","image":"b","env":[{"key":"BAD KEY","value":"` + canary + `"}]}}`

	_, err := registry.Invoke(context.Background(), capability.ContainerCreate, json.RawMessage(payload))

	if err == nil {
		t.Fatal("an invalid environment key was accepted")
	}

	if strings.Contains(err.Error(), canary) {
		t.Fatalf("the refusal quoted the value: %v", err)
	}
}
