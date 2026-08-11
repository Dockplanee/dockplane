package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/config"
	"github.com/dockplane/dockplane/agent/internal/docker"
	"github.com/dockplane/dockplane/agent/internal/gateway"
	"github.com/dockplane/dockplane/agent/internal/host"
	"github.com/dockplane/dockplane/agent/internal/identity"
	"github.com/dockplane/dockplane/agent/internal/metrics"
)

// Failures that will not resolve themselves. Both are reported with an exit
// code of their own so a service manager stops restarting rather than retrying
// a condition only an operator can clear.
var (
	errRevoked     = gateway.ErrRevoked
	errNotEnrolled = errors.New(
		"this host is not enrolled; run: dockplane-agent enroll --server <url>")
)

func runAgent(arguments []string) error {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	flags.Parse(arguments)

	configuration, err := config.Load()

	if err != nil {
		return err
	}

	logger := newLogger(configuration.LogLevel)
	store := identity.NewStore(configuration.StateDir)

	credential, err := store.Load()

	if errors.Is(err, identity.ErrNotEnrolled) {
		return errNotEnrolled
	}

	if err != nil {
		return err
	}

	for _, finding := range store.CheckPermissions() {
		logger.Warn("identity material is too permissive",
			"event", "identity_permissions", "finding", finding)
	}

	/*
	 * Docker is connected lazily in the sense that a daemon which is down does
	 * not stop the agent: the host is still reachable and still worth reporting,
	 * and capabilities answer with a structured DOCKER_UNAVAILABLE until the
	 * daemon returns. Crashing here would produce a restart loop that hides the
	 * actual problem.
	 */
	engine, err := docker.Connect()

	if err != nil {
		logger.Warn("the Docker Engine is not reachable yet",
			"event", "docker_unavailable", "error", err.Error())
	}

	defer func() {
		_ = engine.Close()
	}()

	registry := capability.New()
	capability.Register(registry, capability.Sources{
		Docker:  engine,
		Host:    host.NewCollector(agentVersion()),
		Metrics: metrics.NewCollector(),
	})

	roots, err := configuration.TrustBundle()

	if err != nil {
		return err
	}

	client := gateway.New(gateway.Options{
		Store:         store,
		Registry:      registry,
		Logger:        logger,
		AgentVersion:  agentVersion(),
		ExtraRootsPEM: roots,
	})

	ctx, cancel := signalContext()
	defer cancel()

	logger.Info("starting",
		"event", "agent_starting",
		"agentId", credential.Metadata.AgentID,
		"version", agentVersion(),
		"capabilities", registry.Names())

	if err := client.Run(ctx); err != nil {
		return err
	}

	logger.Info("stopped", "event", "agent_stopped")

	return nil
}

func runStatus(arguments []string) error {
	flags := flag.NewFlagSet("status", flag.ExitOnError)
	flags.Parse(arguments)

	configuration, err := config.Load()

	if err != nil {
		return err
	}

	store := identity.NewStore(configuration.StateDir)
	credential, err := store.Load()

	if errors.Is(err, identity.ErrNotEnrolled) {
		fmt.Println("Not enrolled.")
		fmt.Printf("  state directory: %s\n", store.Dir())
		fmt.Println("\nRun: dockplane-agent enroll --server <url>")

		return nil
	}

	if err != nil {
		return err
	}

	remaining := time.Until(credential.Leaf.NotAfter).Round(time.Hour)

	fmt.Printf("Agent %s\n", credential.Metadata.AgentID)
	fmt.Printf("  gateway:         %s\n", credential.Metadata.GatewayURL)
	fmt.Printf("  state directory: %s\n", store.Dir())
	fmt.Printf("  certificate:     valid until %s (%s remaining)\n",
		credential.Leaf.NotAfter.Format(time.RFC3339), remaining)

	findings := store.CheckPermissions()

	if len(findings) == 0 {
		fmt.Println("  key permissions: owner only")
	} else {
		for _, finding := range findings {
			fmt.Fprintf(os.Stderr, "  warning: %s\n", finding)
		}
	}

	if engine, err := docker.Connect(); err == nil {
		defer func() {
			_ = engine.Close()
		}()

		ctx, cancel := signalContext()
		defer cancel()

		if version, err := engine.Version(ctx); err == nil {
			fmt.Printf("  docker:          %s\n", version)
		} else {
			fmt.Printf("  docker:          unavailable (%s)\n", err)
		}
	} else {
		fmt.Printf("  docker:          unavailable (%s)\n", err)
	}

	return nil
}
