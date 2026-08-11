// Package protocol defines the wire format between the Dockplane agent and the
// control server.
//
// The definitions mirror the server's. Both sides validate independently: the
// agent does not assume a message is safe because the server sent it, and the
// server does not assume a reply is well formed because an authenticated agent
// produced it.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Version is the protocol this agent speaks. It is authoritative for
// compatibility; the agent build version is informational.
const Version = 1

// MaxMessageBytes bounds a single message. A peer that never sends a delimiter
// must not be able to grow the receive buffer without limit.
const MaxMessageBytes = 1 << 20

// Message types sent by the agent.
const (
	TypeHello         = "hello"
	TypeHeartbeat     = "heartbeat"
	TypeRenew         = "certificate.renew"
	TypeResponse      = "response"
	TypeStreamStarted = "stream_started"
	TypeStreamChunk   = "stream_chunk"
	TypeStreamEnd     = "stream_end"
)

// Message types sent by the server.
const (
	TypeHelloAck           = "hello_ack"
	TypeHeartbeatAck       = "heartbeat_ack"
	TypeCertificateRenewed = "certificate.renewed"
	TypeRequest            = "request"
	TypeStreamCancel       = "stream_cancel"
	TypeError              = "error"
)

// Why a stream ended. The agent reports one of these and nothing else.
const (
	StreamCompleted = "completed"
	StreamCancelled = "cancelled"
	StreamFailed    = "failed"
	StreamExpired   = "expired"
)

// Hello opens a connection. It carries no identity: the server derives that
// from the client certificate that completed the TLS handshake.
type Hello struct {
	Type            string   `json:"type"`
	ProtocolVersion int      `json:"protocolVersion"`
	AgentVersion    string   `json:"agentVersion,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
}

// Heartbeat reports liveness.
type Heartbeat struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
}

// RenewCertificate asks for a replacement certificate. It carries no token: the
// current certificate authenticated the connection it arrives on.
type RenewCertificate struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	CSR             string `json:"csr"`
}

// Response answers a capability request.
type Response struct {
	Type            string         `json:"type"`
	ProtocolVersion int            `json:"protocolVersion"`
	ID              string         `json:"id"`
	Capability      string         `json:"capability"`
	Status          string         `json:"status"`
	Payload         any            `json:"payload,omitempty"`
	Error           *ResponseError `json:"error,omitempty"`
}

// ResponseError reports why a capability failed.
type ResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

/*
StreamStarted acknowledges that a streaming capability is running.

It carries the identifier the server assigned rather than one the agent chose,
so the server can bind what follows to the stream it opened.
*/
type StreamStarted struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	ID              string `json:"id"`
	Capability      string `json:"capability"`
	StreamID        string `json:"streamId"`
}

// StreamChunk carries one delivery of a running stream.
type StreamChunk struct {
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	ID              string `json:"id"`
	StreamID        string `json:"streamId"`
	// Seq numbers the chunks of one stream from zero, so a gap is visible.
	Seq     int `json:"seq"`
	Payload any `json:"payload"`
	// Dropped counts what the agent discarded because the consumer was behind.
	Dropped int `json:"dropped,omitempty"`
}

// StreamEnd closes a stream. Nothing more may be sent for that identifier.
type StreamEnd struct {
	Type            string         `json:"type"`
	ProtocolVersion int            `json:"protocolVersion"`
	ID              string         `json:"id"`
	StreamID        string         `json:"streamId"`
	Reason          string         `json:"reason"`
	Error           *ResponseError `json:"error,omitempty"`
}

// ServerMessage is any message the server may send. Fields are read only after
// the type has been established.
type ServerMessage struct {
	Type                     string          `json:"type"`
	ProtocolVersion          int             `json:"protocolVersion"`
	AgentID                  string          `json:"agentId"`
	HeartbeatIntervalSeconds int             `json:"heartbeatIntervalSeconds"`
	CertificateNotAfter      string          `json:"certificateNotAfter"`
	RenewAfter               string          `json:"renewAfter"`
	Certificate              string          `json:"certificate"`
	ID                       string          `json:"id"`
	StreamID                 string          `json:"streamId"`
	Capability               string          `json:"capability"`
	IssuedAt                 string          `json:"issuedAt"`
	ExpiresAt                string          `json:"expiresAt"`
	Payload                  json.RawMessage `json:"payload"`
	Code                     string          `json:"code"`
	Message                  string          `json:"message"`
}

// Errors returned when a server message cannot be trusted.
var (
	ErrUnsupportedVersion = errors.New("unsupported protocol version")
	ErrMalformed          = errors.New("malformed message")
	ErrExpired            = errors.New("request expired")
)

// ParseServerMessage decodes one message and checks what every message must
// carry. Type-specific validation belongs to the caller that acts on it.
func ParseServerMessage(line []byte) (*ServerMessage, error) {
	if len(line) > MaxMessageBytes {
		return nil, fmt.Errorf("%w: %d bytes", ErrMalformed, len(line))
	}

	var message ServerMessage

	if err := json.Unmarshal(line, &message); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}

	if message.Type == "" {
		return nil, fmt.Errorf("%w: no type", ErrMalformed)
	}

	if message.ProtocolVersion != Version {
		return nil, fmt.Errorf("%w: %d", ErrUnsupportedVersion, message.ProtocolVersion)
	}

	return &message, nil
}

// ValidateRequest checks the envelope of a capability request.
//
// The expiry is enforced by the agent as well as by the server. A request that
// waited in a queue, or was replayed, must not run late against a host whose
// state has moved on.
func ValidateRequest(message *ServerMessage, now time.Time) error {
	if message.ID == "" || message.Capability == "" {
		return fmt.Errorf("%w: request without an identifier or capability", ErrMalformed)
	}

	issuedAt, err := time.Parse(time.RFC3339, message.IssuedAt)
	if err != nil {
		return fmt.Errorf("%w: issuedAt", ErrMalformed)
	}

	expiresAt, err := time.Parse(time.RFC3339, message.ExpiresAt)
	if err != nil {
		return fmt.Errorf("%w: expiresAt", ErrMalformed)
	}

	if !expiresAt.After(issuedAt) {
		return fmt.Errorf("%w: expiry is not after issue", ErrMalformed)
	}

	if now.After(expiresAt) {
		return fmt.Errorf("%w: expired at %s", ErrExpired, expiresAt.Format(time.RFC3339))
	}

	return nil
}

// NewSuccess builds a successful reply. The capability is echoed so the server
// can refuse a reply that answers a different question than it asked.
func NewSuccess(id, capability string, payload any) Response {
	return Response{
		Type:            TypeResponse,
		ProtocolVersion: Version,
		ID:              id,
		Capability:      capability,
		Status:          "success",
		Payload:         payload,
	}
}

// NewStreamStarted acknowledges a stream the server asked for.
func NewStreamStarted(id, capability, streamID string) StreamStarted {
	return StreamStarted{
		Type:            TypeStreamStarted,
		ProtocolVersion: Version,
		ID:              id,
		Capability:      capability,
		StreamID:        streamID,
	}
}

// NewStreamChunk builds one delivery.
func NewStreamChunk(id, streamID string, seq int, payload any, dropped int) StreamChunk {
	return StreamChunk{
		Type:            TypeStreamChunk,
		ProtocolVersion: Version,
		ID:              id,
		StreamID:        streamID,
		Seq:             seq,
		Payload:         payload,
		Dropped:         dropped,
	}
}

// NewStreamEnd closes a stream, with a code when it ended badly.
func NewStreamEnd(id, streamID, reason string, failure *ResponseError) StreamEnd {
	return StreamEnd{
		Type:            TypeStreamEnd,
		ProtocolVersion: Version,
		ID:              id,
		StreamID:        streamID,
		Reason:          reason,
		Error:           failure,
	}
}

// NewFailure builds a failed reply.
func NewFailure(id, capability, code, message string) Response {
	return Response{
		Type:            TypeResponse,
		ProtocolVersion: Version,
		ID:              id,
		Capability:      capability,
		Status:          "error",
		Error:           &ResponseError{Code: code, Message: message},
	}
}
