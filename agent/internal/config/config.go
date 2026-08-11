// Package config holds the agent's non-sensitive settings.
//
// Deliberately small. Everything the control server assigns during enrollment —
// the agent identity and the gateway address — is stored with the credential
// and never restated here, so the two cannot disagree about who this agent is.
package config

import (
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultStateDir is the usual location on a Linux host.
const DefaultStateDir = "/var/lib/dockplane-agent"

// Config is the resolved agent configuration.
type Config struct {
	// StateDir holds the credential and identity metadata.
	StateDir string
	// TrustBundlePath optionally pins the authority for the gateway's server
	// certificate. Empty means the system trust store.
	TrustBundlePath string
	// LogLevel is one of debug, info, warn, error.
	LogLevel string
}

// Load resolves configuration from the environment and validates it.
//
// Validation happens at startup so an unusable setting stops the agent with a
// clear message, rather than surfacing later as a connection that never works.
func Load() (*Config, error) {
	configuration := &Config{
		StateDir:        envOr("DOCKPLANE_AGENT_STATE_DIR", DefaultStateDir),
		TrustBundlePath: os.Getenv("DOCKPLANE_AGENT_TRUST_BUNDLE"),
		LogLevel:        strings.ToLower(envOr("DOCKPLANE_AGENT_LOG_LEVEL", "info")),
	}

	if err := configuration.validate(); err != nil {
		return nil, err
	}

	return configuration, nil
}

func (c *Config) validate() error {
	if strings.TrimSpace(c.StateDir) == "" {
		return errors.New("the state directory must not be empty")
	}

	if !filepath.IsAbs(c.StateDir) {
		return fmt.Errorf("the state directory must be an absolute path, got %q", c.StateDir)
	}

	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("unknown log level %q", c.LogLevel)
	}

	if c.TrustBundlePath != "" {
		if _, err := os.Stat(c.TrustBundlePath); err != nil {
			return fmt.Errorf("the trust bundle %s cannot be read", c.TrustBundlePath)
		}
	}

	return nil
}

// TrustBundle reads the configured authority, or nil when none is configured.
//
// The PEM is returned rather than a pool so the caller can combine it with the
// system store and with the authority received at enrollment.
func (c *Config) TrustBundle() ([]byte, error) {
	if c.TrustBundlePath == "" {
		return nil, nil
	}

	contents, err := os.ReadFile(c.TrustBundlePath)

	if err != nil {
		return nil, fmt.Errorf("read the trust bundle %s: %w", c.TrustBundlePath, err)
	}

	if !x509.NewCertPool().AppendCertsFromPEM(contents) {
		return nil, fmt.Errorf("the trust bundle %s holds no usable certificate", c.TrustBundlePath)
	}

	return contents, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}

	return fallback
}
