package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/dockplane/dockplane/agent/internal/config"
	"github.com/dockplane/dockplane/agent/internal/enrollment"
	"github.com/dockplane/dockplane/agent/internal/identity"
)

func runEnroll(arguments []string) error {
	flags := flag.NewFlagSet("enroll", flag.ExitOnError)

	server := flags.String("server", "", "control server base URL, for example https://dockplane.example.com")
	hostname := flags.String("hostname", "", "label shown for this host (defaults to the system hostname)")
	tokenFile := flags.String("token-file", "", "file holding the enrollment token")
	stdinToken := flags.Bool("token-stdin", false, "read the enrollment token from standard input")
	trustBundle := flags.String("ca", "", "PEM bundle trusted for the control server certificate")
	force := flags.Bool("force", false, "replace an existing identity")

	flags.Usage = func() {
		fmt.Fprint(flags.Output(), strings.TrimLeft(`
Usage: dockplane-agent enroll --server <url> [options]

The enrollment token is read from, in order: --token-file, standard input with
--token-stdin, the DOCKPLANE_ENROLLMENT_TOKEN environment variable, or an
interactive prompt.

There is deliberately no --token flag. A token on the command line is visible in
the process list to every user on the host and is written to the shell history.

Options:
`, "\n"))
		flags.PrintDefaults()
	}

	if err := flags.Parse(arguments); err != nil {
		return err
	}

	if strings.TrimSpace(*server) == "" {
		return errors.New("--server is required")
	}

	configuration, err := config.Load()

	if err != nil {
		return err
	}

	store := identity.NewStore(configuration.StateDir)

	if existing, err := store.Load(); err == nil && !*force {
		return fmt.Errorf(
			"this host is already enrolled as %s; pass --force to replace that identity",
			existing.Metadata.AgentID)
	}

	token, err := readToken(*tokenFile, *stdinToken)

	if err != nil {
		return err
	}

	label := *hostname

	if label == "" {
		label, _ = os.Hostname()
	}

	client, err := httpClient(*trustBundle)

	if err != nil {
		return err
	}

	ctx, cancel := signalContext()
	defer cancel()

	result, err := enrollment.Enroll(ctx, store, client, enrollment.Request{
		ServerURL:    strings.TrimRight(*server, "/"),
		Token:        token,
		Hostname:     label,
		CAPEM:        nil,
		AgentVersion: agentVersion(),
	})

	if err != nil {
		return err
	}

	fmt.Printf("Enrolled as %s\n", result.AgentID)
	fmt.Printf("  gateway:     %s\n", result.GatewayURL)
	fmt.Printf("  certificate: valid until %s\n", result.CertificateNotAfter.Format(time.RFC3339))
	fmt.Printf("  state:       %s\n", store.Dir())
	fmt.Println()
	fmt.Println("The private key stays on this host and is never transmitted.")
	fmt.Println("Start the agent with: dockplane-agent run")

	return nil
}

/*
readToken obtains the one-time token without putting it where it can be read
again.

A token on the command line would appear in the process list and the shell
history, so the flag does not exist. Each supported source hands the value
directly to this process.
*/
func readToken(file string, fromStdin bool) (string, error) {
	if file != "" {
		contents, err := os.ReadFile(file)

		if err != nil {
			return "", fmt.Errorf("read the token file: %w", err)
		}

		return strings.TrimSpace(string(contents)), nil
	}

	if fromStdin {
		reader := bufio.NewReader(os.Stdin)
		line, err := reader.ReadString('\n')

		if err != nil && line == "" {
			return "", fmt.Errorf("read the token from standard input: %w", err)
		}

		return strings.TrimSpace(line), nil
	}

	if value := strings.TrimSpace(os.Getenv("DOCKPLANE_ENROLLMENT_TOKEN")); value != "" {
		return value, nil
	}

	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New(
			"no enrollment token supplied; use --token-file, --token-stdin or DOCKPLANE_ENROLLMENT_TOKEN")
	}

	fmt.Fprint(os.Stderr, "Enrollment token: ")

	entered, err := term.ReadPassword(int(os.Stdin.Fd()))

	fmt.Fprintln(os.Stderr)

	if err != nil {
		return "", fmt.Errorf("read the token: %w", err)
	}

	return strings.TrimSpace(string(entered)), nil
}

// httpClient builds the client used for enrollment. The control server's
// certificate is always verified; the optional bundle supports a private
// authority rather than disabling the check.
func httpClient(trustBundlePath string) (*http.Client, error) {
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}

	if trustBundlePath != "" {
		contents, err := os.ReadFile(trustBundlePath)

		if err != nil {
			return nil, fmt.Errorf("read %s: %w", trustBundlePath, err)
		}

		pool := x509.NewCertPool()

		if !pool.AppendCertsFromPEM(contents) {
			return nil, fmt.Errorf("%s holds no usable certificate", trustBundlePath)
		}

		transport.TLSClientConfig.RootCAs = pool
	}

	return &http.Client{Transport: transport, Timeout: 30 * time.Second}, nil
}
