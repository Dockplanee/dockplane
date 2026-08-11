//go:build docker_integration

package docker_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Ownership rules for tests that operate a real Docker daemon.

These tests run against whatever daemon the developer or CI machine has, next to
whatever that machine is actually running. A test that started, stopped or
restarted the wrong container would interrupt real work, and an identifier is
easy to get wrong — a stale name, a copied constant, a container recreated
between runs under the same name.

So ownership is proven rather than assumed. Every container these tests operate
is created by the harness, labelled with this run's identifier, and checked
against that label immediately before each operation. Anything that fails the
check aborts the test instead of being operated on.
*/

const (
	// e2eLabel marks a container as belonging to this test suite.
	e2eLabel = "com.dockplane.e2e"
	// e2eRunLabel carries the identifier of the single run that created it.
	e2eRunLabel = "com.dockplane.e2e.run"
)

/*
The identifier of this test binary's run.

A fresh value per run, so a container left behind by an earlier run — a crash, a
killed test, a developer experimenting — is foreign to this one and is refused
rather than reused.
*/
var runID = newRunID()

func newRunID() string {
	buffer := make([]byte, 8)

	if _, err := rand.Read(buffer); err != nil {
		panic("cannot generate a run identifier: " + err.Error())
	}

	return hex.EncodeToString(buffer)
}

/*
Runs a Docker CLI command for the harness.

Setup and teardown only. Changing the run state of a container is what the code
under test does, and it may only happen through the guarded helpers that prove
ownership first — so the verbs that would bypass them are refused here rather
than trusted not to appear.
*/
func run(t *testing.T, arguments ...string) string {
	t.Helper()

	if len(arguments) > 0 && lifecycleVerbs[arguments[0]] {
		t.Fatalf("docker %s bypasses the ownership guard; use the engine helpers", arguments[0])
	}

	output, err := exec.Command("docker", arguments...).CombinedOutput()

	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(arguments, " "), err, output)
	}

	return strings.TrimSpace(string(output))
}

var lifecycleVerbs = map[string]bool{
	"start":   true,
	"stop":    true,
	"restart": true,
	"kill":    true,
	"pause":   true,
	"unpause": true,
}

// containerName returns a name that belongs to this run and to nothing else.
func containerName(purpose string) string {
	return fmt.Sprintf("dockplane-e2e-%s-%s", runID, purpose)
}

/*
What the harness created, and what it may therefore operate on.

Keyed by name and holding the identifier Docker assigned at creation, so a
container recreated under the same name by anything else is not mistaken for
the one this run started.
*/
var created = map[string]string{}

/*
Starts a container owned by this run, returning its name and identifier.

The command traps SIGTERM so the container stops promptly. The image's default
command ignores it, which would make every stop wait out the full timeout and
say nothing about the code under test.
*/
func createContainer(t *testing.T, purpose string, arguments ...string) (string, string) {
	t.Helper()

	name := containerName(purpose)

	run(t, "pull", "--quiet", testImage)

	command := []string{
		"run", "--detach",
		"--name", name,
		"--label", e2eLabel + "=true",
		"--label", e2eRunLabel + "=" + runID,
	}
	command = append(command, arguments...)
	command = append(command, testImage)
	command = append(command, "sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done")

	id := run(t, command...)
	created[name] = id

	t.Cleanup(func() {
		delete(created, name)
		_ = exec.Command("docker", "rm", "-f", name).Run()
	})

	return name, id
}

/*
Whether this run may operate the named container.

All four conditions have to hold: the harness created it during this run, the
container carries the suite label, it carries this run's identifier, and it is
still the same container Docker created — not a replacement that took the name.
*/
func verifyOwned(name string) error {
	id, ours := created[name]

	if !ours {
		return fmt.Errorf("%s was not created by this test run", name)
	}

	owner, err := inspectOwnership(name)

	if err != nil {
		return err
	}

	if owner.suite != "true" {
		return fmt.Errorf("%s does not carry %s=true", name, e2eLabel)
	}

	if owner.run != runID {
		return fmt.Errorf("%s carries run %q, not %q", name, owner.run, runID)
	}

	if owner.id != id {
		return fmt.Errorf("%s is container %s now, not the %s this run created", name, owner.id, id)
	}

	return nil
}

// mustOwn aborts the test rather than operating on a container it cannot claim.
func mustOwn(t *testing.T, name string) {
	t.Helper()

	if err := verifyOwned(name); err != nil {
		t.Fatalf("refusing to operate a container this run does not own: %v", err)
	}
}

type ownership struct {
	id    string
	suite string
	run   string
}

// inspectOwnership reads the identifier and the two labels from the daemon.
//
// The product code cannot answer this: its inspect projection deliberately
// drops every label except the Compose ones. The check therefore uses the CLI,
// which is the harness's own channel and not the code under test.
func inspectOwnership(name string) (ownership, error) {
	const format = `{{.Id}}	{{index .Config.Labels "` + e2eLabel + `"}}	{{index .Config.Labels "` + e2eRunLabel + `"}}`

	output, err := exec.Command("docker", "inspect", "--format", format, name).Output()

	if err != nil {
		return ownership{}, fmt.Errorf("cannot inspect %s: %w", name, err)
	}

	fields := strings.Split(strings.TrimSpace(string(output)), "\t")

	if len(fields) != 3 {
		return ownership{}, fmt.Errorf("cannot read the ownership of %s from %q", name, output)
	}

	return ownership{id: fields[0], suite: fields[1], run: fields[2]}, nil
}

// containerStates reports the state of every container except the named one,
// read through the product's own discovery so a test can prove that an
// operation on one container left the others where they were.
func containerStates(t *testing.T, engine *docker.Engine, except string) map[string]string {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	summaries, err := engine.ListContainers(ctx)

	if err != nil {
		t.Fatalf("list: %v", err)
	}

	states := map[string]string{}

	for _, summary := range summaries {
		if summary.Name != except {
			states[summary.Name] = summary.State
		}
	}

	return states
}

/* Everything on the host that this run does not own, and what state it is in. */
type foreignState map[string]string

// snapshotForeign records every container that does not belong to this run.
func snapshotForeign() (foreignState, error) {
	output, err := exec.Command(
		"docker", "ps", "--all", "--no-trunc",
		"--format", "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label \""+e2eRunLabel+"\"}}",
	).Output()

	if err != nil {
		return nil, err
	}

	state := foreignState{}

	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		if line == "" {
			continue
		}

		fields := strings.Split(line, "\t")

		if len(fields) < 4 || fields[3] == runID {
			continue
		}

		state[fields[0]+" "+fields[1]] = fields[2]
	}

	return state, nil
}

/*
Guards the whole package against touching anything it does not own.

The per-operation check prevents an operation from reaching a foreign
container. This catches the other direction: whatever the tests did, every
container that was on the host before the run is in the same state after it.

Nothing is put back. A foreign container that moved is a defect in the tests,
and restoring it would hide exactly the thing worth knowing.
*/
func TestMain(m *testing.M) {
	before, err := snapshotForeign()

	if err != nil {
		// No usable daemon. The tests skip themselves for the same reason.
		os.Exit(m.Run())
	}

	code := m.Run()
	after, err := snapshotForeign()

	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot re-read the host after the run: %v\n", err)
		os.Exit(1)
	}

	if changes := diffForeign(before, after); len(changes) > 0 {
		fmt.Fprintln(os.Stderr, "containers not owned by this run changed state:")

		for _, change := range changes {
			fmt.Fprintln(os.Stderr, "  "+change)
		}

		os.Exit(1)
	}

	os.Exit(code)
}

func diffForeign(before, after foreignState) []string {
	var changes []string

	for container, was := range before {
		now, present := after[container]

		switch {
		case !present:
			changes = append(changes, fmt.Sprintf("%s: %s -> removed", container, was))
		case now != was:
			changes = append(changes, fmt.Sprintf("%s: %s -> %s", container, was, now))
		}
	}

	for container, now := range after {
		if _, present := before[container]; !present {
			changes = append(changes, fmt.Sprintf("%s: absent -> %s", container, now))
		}
	}

	sort.Strings(changes)

	return changes
}
