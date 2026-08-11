//go:build docker_integration

package docker_test

import (
	"os/exec"
	"strings"
	"testing"
)

/*
The ownership guard itself.

Everything else in this package trusts the guard to keep an operation away from
a container the run does not own, so the guard is exercised against real
containers rather than assumed to work. Each test creates the container it
examines and removes it again; none of them operates one.
*/

// foreignContainer creates a container outside the harness, so the run has no
// claim on it. It is never started, stopped or restarted — only inspected.
func foreignContainer(t *testing.T, name string, labels ...string) {
	t.Helper()

	_ = exec.Command("docker", "rm", "-f", name).Run()

	run(t, "pull", "--quiet", testImage)

	arguments := []string{"create", "--name", name}

	for _, label := range labels {
		arguments = append(arguments, "--label", label)
	}

	arguments = append(arguments, testImage, "true")
	run(t, arguments...)

	t.Cleanup(func() {
		_ = exec.Command("docker", "rm", "-f", name).Run()
	})
}

func TestGuardRefusesAContainerWithoutTheSuiteLabel(t *testing.T) {
	requireDocker(t).Close()

	name := containerName("unlabelled")
	foreignContainer(t, name)

	// Registered as though the harness had created it, so the label check is
	// what refuses it rather than the bookkeeping.
	created[name] = containerID(t, name)
	t.Cleanup(func() { delete(created, name) })

	err := verifyOwned(name)

	if err == nil {
		t.Fatal("the guard accepted a container carrying no suite label")
	}

	if !strings.Contains(err.Error(), e2eLabel) {
		t.Errorf("error = %v, want it to name the missing label", err)
	}
}

func TestGuardRefusesAContainerFromAnotherRun(t *testing.T) {
	requireDocker(t).Close()

	name := containerName("other-run")
	foreignContainer(t, name, e2eLabel+"=true", e2eRunLabel+"=0000000000000000")

	created[name] = containerID(t, name)
	t.Cleanup(func() { delete(created, name) })

	err := verifyOwned(name)

	if err == nil {
		t.Fatal("the guard accepted a container labelled with another run")
	}

	if !strings.Contains(err.Error(), "0000000000000000") {
		t.Errorf("error = %v, want it to name the foreign run", err)
	}
}

/*
A container the harness never created is refused even if it is labelled.

The labels alone are not proof: anything on the host could carry them, by
accident or because an earlier run left them behind.
*/
func TestGuardRefusesAContainerItDidNotCreate(t *testing.T) {
	requireDocker(t).Close()

	name := containerName("unregistered")
	foreignContainer(t, name, e2eLabel+"=true", e2eRunLabel+"="+runID)

	err := verifyOwned(name)

	if err == nil {
		t.Fatal("the guard accepted a container the run never created")
	}

	if !strings.Contains(err.Error(), "not created by this test run") {
		t.Errorf("error = %v, want it to say the run did not create it", err)
	}
}

/*
A name that was recreated behind the harness's back is refused.

A test holds a name, not a container. If something removes that container and
creates another under the same name, the operation would land on a different
container than the one the test set up.
*/
func TestGuardRefusesAReplacementUnderTheSameName(t *testing.T) {
	requireDocker(t).Close()

	name, _ := createContainer(t, "replaced")

	if err := verifyOwned(name); err != nil {
		t.Fatalf("the guard refused its own container: %v", err)
	}

	run(t, "rm", "-f", name)
	foreignContainer(t, name, e2eLabel+"=true", e2eRunLabel+"="+runID)

	err := verifyOwned(name)

	if err == nil {
		t.Fatal("the guard accepted a replacement that took the name")
	}

	if !strings.Contains(err.Error(), "this run created") {
		t.Errorf("error = %v, want it to say the identifier no longer matches", err)
	}
}

/*
The CLI helper cannot be used to move a container.

Setup goes through the Docker CLI and operations go through the engine, which
checks ownership first. Nothing should be able to take the short route, so the
helper refuses the verbs that would.
*/
func TestHarnessRefusesLifecycleThroughTheCommandLine(t *testing.T) {
	for _, verb := range []string{"start", "stop", "restart", "kill", "pause", "unpause"} {
		if !lifecycleVerbs[verb] {
			t.Errorf("docker %s is not refused by the harness helper", verb)
		}
	}

	for _, verb := range []string{"run", "create", "rm", "pull", "inspect", "ps"} {
		if lifecycleVerbs[verb] {
			t.Errorf("docker %s is refused, but setup needs it", verb)
		}
	}
}

func TestGuardAcceptsAContainerThisRunCreated(t *testing.T) {
	requireDocker(t).Close()

	name, _ := createContainer(t, "owned")

	if err := verifyOwned(name); err != nil {
		t.Fatalf("the guard refused a container this run created: %v", err)
	}
}

/*
The host sweep reports what moved rather than putting it back.

TestMain compares the containers this run does not own before and after. The
comparison is what makes an accidental mutation visible, so it is tested
directly instead of only running at the end.
*/
func TestForeignSweepReportsAChangedContainer(t *testing.T) {
	before := foreignState{"abc container-a": "running", "def container-b": "exited"}
	after := foreignState{"abc container-a": "exited", "ghi container-c": "running"}

	changes := diffForeign(before, after)

	if len(changes) != 3 {
		t.Fatalf("changes = %v, want one changed, one removed and one added", changes)
	}

	for _, expected := range []string{
		"abc container-a: running -> exited",
		"def container-b: exited -> removed",
		"ghi container-c: absent -> running",
	} {
		if !containsLine(changes, expected) {
			t.Errorf("changes = %v, want %q", changes, expected)
		}
	}
}

func TestForeignSweepPassesWhenNothingMoved(t *testing.T) {
	state := foreignState{"abc container-a": "running"}

	if changes := diffForeign(state, state); len(changes) != 0 {
		t.Errorf("changes = %v, want none", changes)
	}
}

/* The sweep ignores this run's own containers, which come and go by design. */
func TestForeignSweepIgnoresContainersOwnedByThisRun(t *testing.T) {
	requireDocker(t).Close()

	before, err := snapshotForeign()

	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	name, _ := createContainer(t, "sweep")

	after, err := snapshotForeign()

	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	if changes := diffForeign(before, after); len(changes) > 0 {
		t.Errorf("creating %s was reported as a foreign change: %v", name, changes)
	}
}

func containsLine(lines []string, wanted string) bool {
	for _, line := range lines {
		if line == wanted {
			return true
		}
	}

	return false
}

func containerID(t *testing.T, name string) string {
	t.Helper()

	owner, err := inspectOwnership(name)

	if err != nil {
		t.Fatalf("inspect %s: %v", name, err)
	}

	return owner.id
}
