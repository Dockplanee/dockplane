package protocol_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/protocol"
)

func request(issued, expires time.Time) *protocol.ServerMessage {
	return &protocol.ServerMessage{
		Type:            protocol.TypeRequest,
		ProtocolVersion: protocol.Version,
		ID:              "11111111-1111-4111-8111-111111111111",
		Capability:      "container.list",
		IssuedAt:        issued.Format(time.RFC3339),
		ExpiresAt:       expires.Format(time.RFC3339),
	}
}

func TestParseRejectsAnUnsupportedProtocolVersion(t *testing.T) {
	_, err := protocol.ParseServerMessage([]byte(`{"type":"request","protocolVersion":99}`))

	if !errors.Is(err, protocol.ErrUnsupportedVersion) {
		t.Fatalf("error = %v, want ErrUnsupportedVersion", err)
	}
}

func TestParseRejectsMalformedInput(t *testing.T) {
	for name, input := range map[string]string{
		"not json":      `this is not json`,
		"no type":       `{"protocolVersion":1}`,
		"not an object": `[1,2,3]`,
	} {
		if _, err := protocol.ParseServerMessage([]byte(input)); !errors.Is(err, protocol.ErrMalformed) {
			t.Errorf("%s: error = %v, want ErrMalformed", name, err)
		}
	}
}

func TestParseRejectsAnOversizedMessage(t *testing.T) {
	oversized := []byte(`{"type":"request","protocolVersion":1,"payload":"` +
		strings.Repeat("x", protocol.MaxMessageBytes) + `"}`)

	if _, err := protocol.ParseServerMessage(oversized); !errors.Is(err, protocol.ErrMalformed) {
		t.Fatalf("error = %v, want ErrMalformed", err)
	}
}

func TestValidateRequestAcceptsAFreshRequest(t *testing.T) {
	now := time.Now()

	if err := protocol.ValidateRequest(request(now, now.Add(time.Minute)), now); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestValidateRequestRejectsAnExpiredRequest(t *testing.T) {
	issued := time.Now().Add(-2 * time.Minute)
	message := request(issued, issued.Add(time.Minute))

	if err := protocol.ValidateRequest(message, time.Now()); !errors.Is(err, protocol.ErrExpired) {
		t.Fatalf("error = %v, want ErrExpired", err)
	}
}

func TestValidateRequestRejectsAnIncoherentWindow(t *testing.T) {
	now := time.Now()
	message := request(now, now.Add(-time.Minute))

	if err := protocol.ValidateRequest(message, now); !errors.Is(err, protocol.ErrMalformed) {
		t.Fatalf("error = %v, want ErrMalformed", err)
	}
}

func TestValidateRequestRejectsAMissingIdentifier(t *testing.T) {
	now := time.Now()
	message := request(now, now.Add(time.Minute))
	message.ID = ""

	if err := protocol.ValidateRequest(message, now); !errors.Is(err, protocol.ErrMalformed) {
		t.Fatalf("error = %v, want ErrMalformed", err)
	}
}
