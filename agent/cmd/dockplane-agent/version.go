package main

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/dockplane/dockplane/agent/internal/protocol"
)

/*
version is set at build time:

	go build -ldflags "-X main.version=1.2.3" ./cmd/dockplane-agent

The fallback is deliberately not a plausible release number. An agent built
without a version should be recognisable as a development build in a host
inventory, not indistinguishable from a released one.
*/
var version = "0.0.0-dev"

// commit is optional build metadata, filled in the same way.
var commit = ""

// buildDate is when the release was produced, RFC 3339, filled the same way.
var buildDate = ""

/*
versionString is what an operator sees, and what a bug report should carry.

Four facts, because each answers a different question: which release this is,
which source it was built from, when, and which protocol it speaks. The last
one is what decides whether this agent and a given control server can talk at
all, so it belongs here rather than only in a handshake nobody reads.
*/
func versionString() string {
	revision := commit

	if revision == "" {
		revision = vcsRevision()
	}

	parts := []string{fmt.Sprintf("dockplane-agent %s", version)}

	if revision != "" {
		parts = append(parts, fmt.Sprintf("commit %s", revision))
	}

	if buildDate != "" {
		parts = append(parts, fmt.Sprintf("built %s", buildDate))
	}

	parts = append(parts,
		fmt.Sprintf("protocol v%d", protocol.Version),
		fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
		runtime.Version(),
	)

	return strings.Join(parts, ", ")
}

// agentVersion is what the control server records for this host.
func agentVersion() string {
	if revision := vcsRevision(); commit == "" && revision != "" {
		return fmt.Sprintf("%s+%s", version, revision)
	}

	if commit != "" {
		return fmt.Sprintf("%s+%s", version, commit)
	}

	return version
}

// vcsRevision reads the revision the Go toolchain stamps into a binary built
// from a repository, so a development build is still identifiable.
func vcsRevision() string {
	information, ok := debug.ReadBuildInfo()

	if !ok {
		return ""
	}

	for _, setting := range information.Settings {
		if setting.Key == "vcs.revision" && len(setting.Value) >= 7 {
			return setting.Value[:7]
		}
	}

	return ""
}
