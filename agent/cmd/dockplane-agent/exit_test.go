package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

/*
The exit codes the service unit depends on.

systemd is told not to restart the agent on two of them, so they are part of
the contract between the binary and its packaging rather than an internal
detail. A code that changed without the unit changing would turn a condition
an operator must clear into a restart every ten seconds, forever.
*/

// build compiles the agent once for the tests below.
func build(t *testing.T) string {
	t.Helper()

	binary := filepath.Join(t.TempDir(), "dockplane-agent")
	command := exec.Command("go", "build", "-o", binary, ".")

	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("building the agent: %v\n%s", err, output)
	}

	return binary
}

func run(t *testing.T, binary string, environment []string, arguments ...string) (string, int) {
	t.Helper()

	command := exec.Command(binary, arguments...)
	command.Env = append(os.Environ(), environment...)

	output, err := command.CombinedOutput()

	var status int

	if err != nil {
		exitError := &exec.ExitError{}

		if !asExitError(err, &exitError) {
			t.Fatalf("running %v: %v", arguments, err)
		}

		status = exitError.ExitCode()
	}

	return string(output), status
}

func asExitError(err error, target **exec.ExitError) bool {
	if exitError, ok := err.(*exec.ExitError); ok {
		*target = exitError

		return true
	}

	return false
}

/*
A host that was never enrolled is not a crash.

It reports exit code 4, which the unit lists in RestartPreventExitStatus, so
the service stops and waits for someone to enroll the host instead of writing
the same line into the journal every ten seconds until they do.
*/
func TestRunWithoutAnIdentityExitsWithItsOwnCode(t *testing.T) {
	binary := build(t)
	state := t.TempDir()

	output, status := run(t, binary, []string{"DOCKPLANE_AGENT_STATE_DIR=" + state}, "run")

	if status != exitNotEnrolled {
		t.Errorf("exit status = %d, want %d\n%s", status, exitNotEnrolled, output)
	}

	if !strings.Contains(output, "not enrolled") {
		t.Errorf("the message does not say the host is not enrolled:\n%s", output)
	}

	if !strings.Contains(output, "dockplane-agent enroll") {
		t.Errorf("the message does not say what to do about it:\n%s", output)
	}
}

// An unknown command is a usage error, which is a different thing again.
func TestAnUnknownCommandIsAUsageError(t *testing.T) {
	binary := build(t)

	_, status := run(t, binary, nil, "definitely-not-a-command")

	if status != exitUsage {
		t.Errorf("exit status = %d, want %d", status, exitUsage)
	}
}

/*
The unit refuses to restart on exactly the codes the binary reports.

Read out of the shipped unit rather than restated here, because the pair only
works if the two files agree.
*/
func TestTheUnitRefusesToRestartOnTheseCodes(t *testing.T) {
	unit, err := os.ReadFile(filepath.Join("..", "..", "packaging", "dockplane-agent.service"))

	if err != nil {
		t.Fatalf("reading the unit: %v", err)
	}

	matches := regexp.MustCompile(`(?m)^RestartPreventExitStatus=(.+)$`).FindStringSubmatch(string(unit))

	if matches == nil {
		t.Fatal("the unit does not set RestartPreventExitStatus")
	}

	codes := strings.Fields(matches[1])

	for _, want := range []string{"3", "4"} {
		found := false

		for _, code := range codes {
			if code == want {
				found = true
			}
		}

		if !found {
			t.Errorf("RestartPreventExitStatus does not list %s; it has %v", want, codes)
		}
	}
}

/*
The unit runs the binary from the path the package installs it to.

A unit and a package that disagree produce a service that cannot start, and
the failure names a missing file rather than the mistake.
*/
func TestTheUnitRunsTheInstalledPath(t *testing.T) {
	unit, err := os.ReadFile(filepath.Join("..", "..", "packaging", "dockplane-agent.service"))

	if err != nil {
		t.Fatalf("reading the unit: %v", err)
	}

	if !strings.Contains(string(unit), "ExecStart=/usr/bin/dockplane-agent run") {
		t.Error("the unit does not run /usr/bin/dockplane-agent, which is where the package installs it")
	}
}
