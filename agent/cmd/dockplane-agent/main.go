// Command dockplane-agent connects a Docker host to a Dockplane control server.
//
// It reports host facts, container state and Compose projects, streams a
// container's output, and starts, stops or restarts a container the control
// server asks it to. That is the whole of what it can do: the set of
// capabilities is fixed at build time, there is no remove, exec, attach or
// shell, and no request carries a command to execute on the host.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// Exit codes. Revocation is distinguished so a service manager can stop
// restarting an agent that will never be trusted again.
const (
	exitFailure = 1
	exitUsage   = 2
	exitRevoked = 3
	// A host that was never enrolled has nothing to connect with. Restarting
	// it every few seconds would fill a journal with the same line until
	// someone enrolls it, which is not how a service should ask for
	// attention.
	exitNotEnrolled = 4
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(exitUsage)
	}

	command := os.Args[1]
	arguments := os.Args[2:]

	var err error

	switch command {
	case "enroll":
		err = runEnroll(arguments)
	case "run":
		err = runAgent(arguments)
	case "status":
		err = runStatus(arguments)
	case "version":
		fmt.Println(versionString())
		return
	case "help", "-h", "--help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", command)
		usage()
		os.Exit(exitUsage)
	}

	if err == nil {
		return
	}

	fmt.Fprintf(os.Stderr, "%s\n", err)

	if errors.Is(err, errRevoked) {
		os.Exit(exitRevoked)
	}

	if errors.Is(err, errNotEnrolled) {
		os.Exit(exitNotEnrolled)
	}

	os.Exit(exitFailure)
}

func usage() {
	fmt.Fprint(os.Stderr, strings.TrimLeft(`
dockplane-agent — connect a Docker host to a Dockplane control server

Commands:
  enroll    Exchange an enrollment token for this host's own credential
  run       Maintain the connection and answer read-only requests
  status    Report the stored identity and local readiness
  version   Print the agent version

Run "dockplane-agent <command> -h" for the options of a command.
`, "\n"))
}

// newLogger builds the structured logger. Output is JSON so a service manager
// or log shipper can read it without parsing prose.
func newLogger(level string) *slog.Logger {
	var parsed slog.Level

	switch level {
	case "debug":
		parsed = slog.LevelDebug
	case "warn":
		parsed = slog.LevelWarn
	case "error":
		parsed = slog.LevelError
	default:
		parsed = slog.LevelInfo
	}

	return slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: parsed})).
		With("service", "dockplane-agent")
}

// signalContext cancels on SIGTERM or SIGINT so shutdown is orderly: the
// connection is closed, in-flight capabilities finish, and the process exits
// rather than being killed.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
}
