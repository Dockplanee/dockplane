// The Dockplane Compose compiler.
//
// Compose files are parsed here, once, in a process of their own — not on the
// hosts Dockplane manages. The agent stays small and receives a typed plan
// somebody else has already resolved; it never learns what a Compose file is.
//
// It is not a service. It has no network port, no HTTP interface and no Docker
// client. It reads one request on standard input, writes one answer on standard
// output, and exits. That is the whole of its surface, which is what makes it
// safe to hand it the contents of a Compose file and the values of somebody's
// secrets.
//
// Those secrets are why the input arrives on standard input and nowhere else.
// A command line is readable by every process on the machine, an environment is
// inherited by children, and a temporary file outlives the process that wrote
// it. Standard input is none of those things.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// ProtocolVersion is the request and response shape this build speaks.
const ProtocolVersion = 1

// Limits on what a request may contain.
//
// The input is written by whoever is using Dockplane, so every part of it is
// bounded. The numbers are generous for a real Compose file and small enough
// that a hostile one cannot exhaust the control server that spawned this.
const (
	maxInputBytes    = 1 << 20 // 1 MiB of request, compose file included
	maxComposeBytes  = 512 << 10
	maxEnvironment   = 512
	maxEnvKeyBytes   = 256
	maxEnvValueBytes = 32 << 10
	maxServices      = 100
	maxNetworks      = 50
	maxVolumes       = 100
)

// Request is what the control server sends.
type Request struct {
	ProtocolVersion int               `json:"protocolVersion"`
	ProjectName     string            `json:"projectName"`
	Compose         string            `json:"compose"`
	Environment     map[string]string `json:"environment"`
}

// Response is what this writes, exactly once, on standard output.
//
// The envelope carries the outcome rather than the exit code alone. A caller
// that had to infer "the compose file was rejected" from a number could not
// tell it apart from "the compiler could not run", and those two need different
// answers: one is the operator's to fix, the other is not.
type Response struct {
	ProtocolVersion int                  `json:"protocolVersion"`
	OK              bool                 `json:"ok"`
	Plan            *StackDeploymentPlan `json:"plan,omitempty"`
	Errors          []Problem            `json:"errors,omitempty"`
}

// Problem is one reason a Compose file was not accepted.
//
// The path is where in the file to look, the code is what a program should
// match on, and the message is for the person reading it. None of the three
// ever carries a value from the environment.
type Problem struct {
	Path    string `json:"path,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Exit codes.
//
// A rejected Compose file is a successful run: the compiler was asked a
// question and answered it. Only a request that could not be read, or a failure
// inside the compiler, exits non-zero — and the control server treats any
// non-zero exit as a refusal to deploy.
const (
	exitOK         = 0
	exitBadRequest = 2
	exitInternal   = 3
)

func main() {
	os.Exit(run(os.Stdin, os.Stdout, os.Stderr))
}

func run(stdin io.Reader, stdout, stderr io.Writer) int {
	request, err := readRequest(stdin)

	if err != nil {
		// Deliberately terse. The request contained an environment, and an
		// error quoting what it could not parse would quote a secret.
		fmt.Fprintln(stderr, "compose-compiler: the request could not be read:", err)

		return exitBadRequest
	}

	plan, problems := Compile(request)

	response := Response{ProtocolVersion: ProtocolVersion, OK: len(problems) == 0}

	if response.OK {
		response.Plan = plan
	} else {
		response.Errors = problems
	}

	encoded, err := json.Marshal(response)

	if err != nil {
		fmt.Fprintln(stderr, "compose-compiler: the answer could not be encoded")

		return exitInternal
	}

	// Exactly one line, and nothing else on this stream. Anything the compiler
	// has to say goes to standard error, so what the caller parses is never
	// something the caller has to find first.
	if _, err := stdout.Write(append(encoded, '\n')); err != nil {
		return exitInternal
	}

	return exitOK
}

func readRequest(stdin io.Reader) (Request, error) {
	raw, err := io.ReadAll(io.LimitReader(stdin, maxInputBytes+1))

	if err != nil {
		return Request{}, errors.New("standard input could not be read")
	}

	if len(raw) > maxInputBytes {
		return Request{}, fmt.Errorf("the request is larger than %d bytes", maxInputBytes)
	}

	decoder := json.NewDecoder(newBytesReader(raw))

	// A field nobody modelled is a field somebody expected to have an effect.
	// Refusing it is how a request that means something else stops being
	// mistaken for one that means this.
	decoder.DisallowUnknownFields()

	var request Request

	if err := decoder.Decode(&request); err != nil {
		return Request{}, errors.New("the request is not the JSON this expects")
	}

	if decoder.More() {
		return Request{}, errors.New("the request carries more than one document")
	}

	if request.ProtocolVersion != ProtocolVersion {
		return Request{}, fmt.Errorf(
			"protocol version %d is not supported; this build speaks %d",
			request.ProtocolVersion,
			ProtocolVersion,
		)
	}

	return request, nil
}
