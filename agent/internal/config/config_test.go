package config_test

import (
	"os"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/config"
)

func TestLoadUsesTheDefaultStateDirectory(t *testing.T) {
	t.Setenv("DOCKPLANE_AGENT_STATE_DIR", "")

	configuration, err := config.Load()

	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if configuration.StateDir != config.DefaultStateDir {
		t.Errorf("state directory = %q, want %q", configuration.StateDir, config.DefaultStateDir)
	}
}

func TestLoadRejectsARelativeStateDirectory(t *testing.T) {
	t.Setenv("DOCKPLANE_AGENT_STATE_DIR", "state")

	if _, err := config.Load(); err == nil {
		t.Fatal("expected a relative state directory to be refused")
	}
}

func TestLoadRejectsAnUnknownLogLevel(t *testing.T) {
	t.Setenv("DOCKPLANE_AGENT_LOG_LEVEL", "verbose")

	if _, err := config.Load(); err == nil {
		t.Fatal("expected an unknown log level to be refused")
	}
}

func TestLoadRejectsAnUnreadableTrustBundle(t *testing.T) {
	t.Setenv("DOCKPLANE_AGENT_TRUST_BUNDLE", "/no/such/bundle.pem")

	if _, err := config.Load(); err == nil {
		t.Fatal("expected an unreadable trust bundle to be refused")
	}
}

func TestTrustBundleRejectsAFileWithoutACertificate(t *testing.T) {
	path := t.TempDir() + "/bundle.pem"

	if err := os.WriteFile(path, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Setenv("DOCKPLANE_AGENT_TRUST_BUNDLE", path)

	configuration, err := config.Load()

	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if _, err := configuration.TrustBundle(); err == nil {
		t.Fatal("expected a bundle without a certificate to be refused")
	}
}
