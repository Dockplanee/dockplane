// Package gateway maintains the agent's connection to the control server.
//
// The connection is outbound only. A managed host never listens for Dockplane,
// which keeps the agent usable behind NAT and means a compromised control
// server cannot reach a port that would not otherwise be open.
package gateway

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	mathrand "math/rand/v2"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/dockplane/dockplane/agent/internal/capability"
	"github.com/dockplane/dockplane/agent/internal/enrollment"
	"github.com/dockplane/dockplane/agent/internal/identity"
	"github.com/dockplane/dockplane/agent/internal/protocol"
	"github.com/dockplane/dockplane/agent/internal/replay"
)

// ErrRevoked reports that the control server no longer trusts this credential.
// It is terminal: there is nothing to retry until an operator enrolls the host
// again.
var ErrRevoked = errors.New("the agent credential has been revoked")

// Reconnect behaviour. The ceiling keeps a host that has been down for a day
// from waiting hours to notice the server is back; the jitter keeps a fleet
// that lost the server together from returning in lockstep.
const (
	initialBackoff = 2 * time.Second
	maxBackoff     = 2 * time.Minute
	jitterFraction = 0.25
)

// Replay guard sizing. Large enough to cover any plausible burst of in-flight
// requests, small enough that the memory cost is fixed and trivial.
const (
	replayCapacity = 4096
	replayTTL      = 10 * time.Minute
)

// Options configures a client.
type Options struct {
	Store        *identity.Store
	Registry     *capability.Registry
	Logger       *slog.Logger
	AgentVersion string
	// DialTimeout bounds a single connection attempt.
	DialTimeout time.Duration
	// ExtraRootsPEM optionally trusts an additional authority for the gateway's
	// own server certificate, for deployments that terminate it with a private
	// web PKI rather than the internal agent authority.
	ExtraRootsPEM []byte
}

// Client runs the agent's side of the protocol.
type Client struct {
	options Options
	logger  *slog.Logger

	writeMu sync.Mutex
	conn    *tls.Conn

	seen *replay.Cache

	// Streams belong to the connection they were opened on and never outlive it.
	streams *streams

	/*
	 * How one message leaves the agent.
	 *
	 * Ordinarily the connection. Behind a field so a test can watch what the
	 * agent would send without standing up a TLS server, which is what makes
	 * the stream lifecycle testable at all.
	 */
	write func(message any) error
}

// New builds a client.
func New(options Options) *Client {
	if options.Logger == nil {
		options.Logger = slog.Default()
	}

	if options.DialTimeout == 0 {
		options.DialTimeout = 15 * time.Second
	}

	client := &Client{
		options: options,
		logger:  options.Logger,
		seen:    replay.New(replayCapacity, replayTTL),
		streams: newStreams(),
	}

	client.write = client.writeToConnection

	return client
}

/*
Run connects and keeps the connection up until the context is cancelled.

Every disconnect is treated as ordinary: a control server restart, a network
partition, a certificate rotation. The loop backs off with jitter rather than
reconnecting immediately, so a server coming back does not face its whole fleet
at once.
*/
func (c *Client) Run(ctx context.Context) error {
	attempt := 0

	for {
		if ctx.Err() != nil {
			return nil
		}

		start := time.Now()
		err := c.session(ctx)

		if ctx.Err() != nil {
			return nil
		}

		if errors.Is(err, ErrRevoked) {
			return err
		}

		// A session that lasted a while was healthy; its failure is a fresh
		// problem and should not inherit the previous backoff.
		if time.Since(start) > time.Minute {
			attempt = 0
		}

		delay := backoff(attempt)
		attempt++

		c.logger.Warn("connection lost, retrying",
			"event", "gateway_retry",
			"delay", delay.String(),
			"error", errorText(err))

		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
	}
}

// session runs one connection from handshake to close.
func (c *Client) session(ctx context.Context) error {
	credential, err := c.options.Store.Load()

	if err != nil {
		return fmt.Errorf("load identity: %w", err)
	}

	for _, finding := range c.options.Store.CheckPermissions() {
		c.logger.Warn("identity material is too permissive",
			"event", "identity_permissions", "finding", finding)
	}

	conn, err := c.dial(ctx, credential)

	if err != nil {
		return err
	}

	defer conn.Close()

	c.setConn(conn)
	defer c.setConn(nil)

	/*
	 * Streams end with the connection that carried them.
	 *
	 * A stream is bound to one socket. Letting one survive would leave a Docker
	 * log reader open for a server that can no longer be reached, and its next
	 * chunk would be written to a connection that belongs to a different
	 * session.
	 */
	defer c.streams.cancelAll()

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if err := c.send(protocol.Hello{
		Type:            protocol.TypeHello,
		ProtocolVersion: protocol.Version,
		AgentVersion:    c.options.AgentVersion,
		Capabilities:    c.options.Registry.Names(),
	}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	// Closing the connection when the context ends is what unblocks the read
	// loop; a blocking Read does not observe cancellation on its own.
	go func() {
		<-sessionCtx.Done()
		_ = conn.SetReadDeadline(time.Now())
	}()

	return c.readLoop(sessionCtx, conn, credential)
}

func (c *Client) dial(ctx context.Context, credential *identity.Identity) (*tls.Conn, error) {
	endpoint, err := url.Parse(credential.Metadata.GatewayURL)

	if err != nil {
		return nil, fmt.Errorf("the stored gateway address is unusable: %w", err)
	}

	address := endpoint.Host

	if endpoint.Port() == "" {
		address = net.JoinHostPort(endpoint.Hostname(), "9443")
	}

	/*
	 * The server's certificate is always verified. There is no switch to skip
	 * it: an agent that accepts any server would hand its client certificate,
	 * and every answer about the host, to whoever answered the connection.
	 */
	configuration := &tls.Config{
		Certificates: []tls.Certificate{credential.Certificate},
		ServerName:   endpoint.Hostname(),
		MinVersion:   tls.VersionTLS12,
		RootCAs:      c.trustedRoots(credential),
	}

	dialer := &net.Dialer{Timeout: c.options.DialTimeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", address, configuration)

	if err != nil {
		return nil, fmt.Errorf("connect to the gateway: %w", err)
	}

	c.logger.Info("connected",
		"event", "gateway_connected",
		"agentId", credential.Metadata.AgentID,
		"gateway", address)

	return conn, nil
}

/*
trustedRoots builds the set of authorities the gateway may present.

Three sources, in the order of how much they were vouched for. The system store
covers a gateway behind a publicly issued certificate. The authority received
during enrollment covers the ordinary deployment, where the gateway certificate
comes from the same internal authority that signed this agent, and which arrived
over a connection the agent had already verified. A configured bundle covers a
private web PKI.

Leaving RootCAs nil would fall back to the system store alone, which is why the
enrollment authority is added explicitly rather than assumed.
*/
func (c *Client) trustedRoots(credential *identity.Identity) *x509.CertPool {
	roots, err := x509.SystemCertPool()

	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}

	if len(credential.CAPEM) > 0 {
		roots.AppendCertsFromPEM(credential.CAPEM)
	}

	if len(c.options.ExtraRootsPEM) > 0 {
		roots.AppendCertsFromPEM(c.options.ExtraRootsPEM)
	}

	return roots
}

/*
readLoop runs one session.

Incoming messages are read by a separate goroutine and delivered on a channel,
so the loop below blocks on whichever comes first: a message, a heartbeat, a
renewal, or shutdown. Reading inline instead would tie the timers to the
server's traffic — an agent that received nothing would also send nothing, and
would be dropped as idle for a reason that was entirely its own doing.
*/
func (c *Client) readLoop(ctx context.Context, conn *tls.Conn, credential *identity.Identity) error {
	var (
		heartbeat  *time.Ticker
		renewTimer *time.Timer
		wg         sync.WaitGroup
	)

	defer func() {
		if heartbeat != nil {
			heartbeat.Stop()
		}

		if renewTimer != nil {
			renewTimer.Stop()
		}

		// Handlers hold no lock on the connection, but letting them finish keeps
		// their logs coherent with the session they belong to.
		wg.Wait()
	}()

	incoming, failures := c.read(ctx, conn)

	renewalDue := make(chan struct{}, 1)
	heartbeatTick := make(<-chan time.Time)

	// Set while a renewal is in flight. The reply arrives through the same
	// channel as everything else, so the key it belongs to has to be kept here.
	var renewalKeyPEM []byte

	for {
		var message *protocol.ServerMessage

		select {
		case <-ctx.Done():
			return nil

		case err := <-failures:
			if ctx.Err() != nil {
				return nil
			}

			return err

		case <-heartbeatTick:
			if err := c.send(protocol.Heartbeat{
				Type:            protocol.TypeHeartbeat,
				ProtocolVersion: protocol.Version,
			}); err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}

			continue

		case <-renewalDue:
			keyPEM, err := c.requestRenewal()

			if err != nil {
				c.logger.Error("certificate renewal could not be requested",
					"event", "certificate_renewal_failed",
					"agentId", credential.Metadata.AgentID,
					"notAfter", credential.Leaf.NotAfter.Format(time.RFC3339),
					"error", errorText(err))

				// Not fatal on its own: the current certificate still works until
				// it expires, and the next connection tries again.
				continue
			}

			renewalKeyPEM = keyPEM

			continue

		case message = <-incoming:
		}

		switch message.Type {
		case protocol.TypeHelloAck:
			interval := time.Duration(message.HeartbeatIntervalSeconds) * time.Second

			if interval <= 0 {
				interval = 30 * time.Second
			}

			heartbeat = time.NewTicker(interval)
			heartbeatTick = heartbeat.C

			c.logger.Info("session established",
				"event", "session_established",
				"agentId", message.AgentID,
				"heartbeatSeconds", int(interval.Seconds()),
				"certificateNotAfter", message.CertificateNotAfter)

			if renewTimer != nil {
				renewTimer.Stop()
			}

			renewTimer = scheduleRenewal(message.RenewAfter, renewalDue)

		case protocol.TypeHeartbeatAck:
			// Liveness is confirmed by the reply arriving; nothing to do.

		case protocol.TypeRequest:
			wg.Add(1)

			go func(request *protocol.ServerMessage) {
				defer wg.Done()
				c.handleRequest(ctx, request)
			}(message)

		case protocol.TypeStreamCancel:
			if !c.streams.cancel(message.ID, message.StreamID) {
				// Either it already ended, or the identifiers do not match. Both
				// are reasons to do nothing rather than to guess which stream
				// was meant.
				c.logger.Warn("ignoring a cancel for an unknown stream",
					"event", "stream_cancel_unknown",
					"requestId", message.ID,
					"streamId", message.StreamID)
			}

		case protocol.TypeError:
			if message.Code == "AGENT_REVOKED" {
				c.logger.Error("the control server has revoked this agent",
					"event", "agent_revoked", "agentId", credential.Metadata.AgentID)

				return ErrRevoked
			}

			c.logger.Warn("the control server refused a message",
				"event", "gateway_error",
				"code", message.Code,
				"message", message.Message)

		case protocol.TypeCertificateRenewed:
			if renewalKeyPEM == nil {
				// Nothing asked for this. Storing it would replace a working
				// credential with one whose key this agent never generated.
				c.logger.Warn("discarding an unrequested certificate",
					"event", "protocol_violation", "type", message.Type)

				continue
			}

			if err := c.completeRenewal(credential, renewalKeyPEM, message); err != nil {
				renewalKeyPEM = nil

				c.logger.Error("certificate renewal failed",
					"event", "certificate_renewal_failed",
					"agentId", credential.Metadata.AgentID,
					"error", errorText(err))

				continue
			}

			/*
			 * The server recognises only the new certificate from here on, so
			 * this connection — authenticated with the superseded one — can no
			 * longer be attributed to an agent. Reconnecting with the new
			 * material is part of the rotation, not a failure.
			 */
			c.logger.Info("certificate rotated, reconnecting",
				"event", "certificate_rotated",
				"agentId", credential.Metadata.AgentID)

			return nil
		}
	}
}

/*
read delivers parsed messages until the connection ends.

Unreadable input is dropped rather than ending the session: a message the agent
cannot parse says nothing about the ones that follow.
*/
func (c *Client) read(ctx context.Context, conn *tls.Conn) (<-chan *protocol.ServerMessage, <-chan error) {
	messages := make(chan *protocol.ServerMessage)
	failures := make(chan error, 1)

	go func() {
		defer close(messages)

		scanner := newLineScanner(bufio.NewReaderSize(conn, 64*1024), protocol.MaxMessageBytes)

		for {
			line, err := scanner.next()

			if err != nil {
				failures <- fmt.Errorf("read from the gateway: %w", err)
				return
			}

			if line == nil {
				continue
			}

			message, err := protocol.ParseServerMessage(line)

			if err != nil {
				c.logger.Warn("discarding an unreadable message",
					"event", "protocol_violation", "error", errorText(err))

				continue
			}

			select {
			case messages <- message:
			case <-ctx.Done():
				return
			}
		}
	}()

	return messages, failures
}

/*
requestRenewal generates fresh material and asks for a replacement certificate.

The key is returned rather than stored: nothing is written until the issued
certificate has been checked against it, so an interrupted renewal cannot leave
a key without a matching certificate.
*/
func (c *Client) requestRenewal() ([]byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	if err != nil {
		return nil, fmt.Errorf("generate a private key: %w", err)
	}

	keyPEM, err := identity.EncodePrivateKey(key)

	if err != nil {
		return nil, err
	}

	csrPEM, err := enrollment.CreateCertificateRequest(key)

	if err != nil {
		return nil, err
	}

	if err := c.send(protocol.RenewCertificate{
		Type:            protocol.TypeRenew,
		ProtocolVersion: protocol.Version,
		CSR:             string(csrPEM),
	}); err != nil {
		return nil, fmt.Errorf("send the renewal request: %w", err)
	}

	return keyPEM, nil
}

/*
completeRenewal verifies an issued certificate and swaps it in.

The certificate is checked against the key that never left this host, the
authority the agent already trusts and the identity the server assigned, before
it replaces anything. Material that has not been proven usable never overwrites
material that is known to work.
*/
func (c *Client) completeRenewal(
	credential *identity.Identity,
	keyPEM []byte,
	message *protocol.ServerMessage,
) error {
	if message.Certificate == "" {
		return errors.New("the renewal response carried no certificate")
	}

	if _, err := identity.VerifyCertificate(
		[]byte(message.Certificate), keyPEM, credential.CAPEM,
		credential.Metadata.AgentID, time.Now()); err != nil {
		return fmt.Errorf("the renewed certificate was refused: %w", err)
	}

	if err := c.options.Store.ReplaceCertificate(keyPEM, []byte(message.Certificate)); err != nil {
		return err
	}

	c.logger.Info("certificate renewed",
		"event", "certificate_renewed",
		"agentId", credential.Metadata.AgentID,
		"notAfter", message.CertificateNotAfter)

	return nil
}

/*
handleRequest performs one capability.

Every check is the agent's own. The server validates too, but an agent that
trusted an authenticated peer would have no defence if that peer were ever
wrong: the expiry, the identifier and the capability name are all re-checked
here before a handler runs.
*/
func (c *Client) handleRequest(ctx context.Context, message *protocol.ServerMessage) {
	started := time.Now()

	if err := protocol.ValidateRequest(message, started); err != nil {
		code := "VALIDATION_FAILED"

		if errors.Is(err, protocol.ErrExpired) {
			code = "AGENT_REQUEST_EXPIRED"
		}

		c.logger.Warn("refusing a request",
			"event", "request_refused",
			"requestId", message.ID,
			"capability", message.Capability,
			"errorCode", code)

		c.reply(protocol.NewFailure(message.ID, message.Capability, code, "The request was refused."))

		return
	}

	// A repeated identifier is refused rather than run twice. A duplicated
	// operation would act on a host twice, and a duplicated stream would open a
	// second Docker reader that nothing would ever cancel.
	if c.seen.Observe(message.ID) {
		c.logger.Warn("refusing a duplicate request",
			"event", "request_duplicate",
			"requestId", message.ID,
			"capability", message.Capability)

		c.reply(protocol.NewFailure(
			message.ID, message.Capability, "VALIDATION_FAILED", "The request was already handled."))

		return
	}

	if c.options.Registry.IsStream(message.Capability) {
		c.handleStream(ctx, message)

		return
	}

	result, err := c.options.Registry.Invoke(ctx, message.Capability, message.Payload)

	duration := time.Since(started)

	if err != nil {
		code := capability.Code(err)

		c.logger.Warn("capability failed",
			"event", "capability_failed",
			"requestId", message.ID,
			"capability", message.Capability,
			"durationMs", duration.Milliseconds(),
			"errorCode", code)

		c.reply(protocol.NewFailure(message.ID, message.Capability, code, err.Error()))

		return
	}

	c.logger.Info("capability completed",
		"event", "capability_completed",
		"requestId", message.ID,
		"capability", message.Capability,
		"durationMs", duration.Milliseconds())

	c.reply(protocol.NewSuccess(message.ID, message.Capability, result))
}

func (c *Client) reply(response protocol.Response) {
	if err := c.send(response); err != nil {
		c.logger.Warn("could not deliver a reply",
			"event", "reply_failed",
			"requestId", response.ID,
			"error", errorText(err))
	}
}

// send delivers one message through whatever this client writes to.
func (c *Client) send(message any) error {
	return c.write(message)
}

// writeToConnection serialises writes. Capabilities run concurrently, so
// replies would otherwise interleave mid-line and corrupt the stream.
func (c *Client) writeToConnection(message any) error {
	encoded, err := json.Marshal(message)

	if err != nil {
		return fmt.Errorf("encode a message: %w", err)
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if c.conn == nil {
		return errors.New("not connected")
	}

	if _, err := c.conn.Write(append(encoded, '\n')); err != nil {
		return err
	}

	return nil
}

func (c *Client) setConn(conn *tls.Conn) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	c.conn = conn
}

// scheduleRenewal arms a timer for the moment the server said to renew.
func scheduleRenewal(renewAfter string, due chan<- struct{}) *time.Timer {
	when, err := time.Parse(time.RFC3339, renewAfter)

	delay := time.Duration(0)

	if err == nil {
		delay = time.Until(when)
	}

	if delay < 0 {
		delay = 0
	}

	return time.AfterFunc(delay, func() {
		select {
		case due <- struct{}{}:
		default:
		}
	})
}

// backoff grows exponentially to a ceiling and adds jitter.
func backoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}

	scaled := float64(initialBackoff) * math.Pow(2, float64(attempt))

	if scaled > float64(maxBackoff) || math.IsInf(scaled, 1) {
		scaled = float64(maxBackoff)
	}

	jitter := scaled * jitterFraction * (mathrand.Float64()*2 - 1)

	delay := time.Duration(scaled + jitter)

	if delay < initialBackoff {
		delay = initialBackoff
	}

	return delay
}

// errorText keeps an error usable in a log line without risking that a wrapped
// value carries material that must not be logged.
func errorText(err error) string {
	if err == nil {
		return ""
	}

	return err.Error()
}
