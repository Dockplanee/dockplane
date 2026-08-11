// Package enrollment exchanges a one-time token for a client certificate.
//
// The key pair is generated here and the private key is written to the state
// directory; it is never sent anywhere. The token authorises exactly this one
// exchange and is deliberately not persisted afterwards, so a host that is
// compromised later does not yield a credential that could enroll again.
package enrollment

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dockplane/dockplane/agent/internal/identity"
	"github.com/dockplane/dockplane/agent/internal/protocol"
)

// The server bounds the request body; refusing early gives a clearer failure
// than a truncated read.
const maxResponseBytes = 1 << 20

// Request is what the operator supplies.
type Request struct {
	ServerURL string
	Token     string
	Hostname  string
	// CAPEM optionally pins the authority for the control API. Empty means the
	// system trust store, which is correct for a publicly issued certificate.
	CAPEM        []byte
	AgentVersion string
}

// Result is what the server assigned.
type Result struct {
	AgentID             string
	GatewayURL          string
	CertificateNotAfter time.Time
}

type enrollmentRequest struct {
	Token           string `json:"token"`
	CSR             string `json:"csr"`
	ProtocolVersion int    `json:"protocolVersion"`
	Hostname        string `json:"hostname,omitempty"`
	AgentVersion    string `json:"agentVersion,omitempty"`
}

type enrollmentResponse struct {
	AgentID             string `json:"agentId"`
	Certificate         string `json:"certificate"`
	CAChain             string `json:"caChain"`
	GatewayURL          string `json:"gatewayUrl"`
	ProtocolVersion     int    `json:"protocolVersion"`
	CertificateNotAfter string `json:"certificateNotAfter"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Enroll performs the exchange and persists the resulting identity.
func Enroll(ctx context.Context, store *identity.Store, client *http.Client, request Request) (*Result, error) {
	if strings.TrimSpace(request.Token) == "" {
		return nil, errors.New("an enrollment token is required")
	}

	endpoint, err := url.JoinPath(request.ServerURL, "/api/v1/agent-enrollments")

	if err != nil {
		return nil, fmt.Errorf("build the enrollment address: %w", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	if err != nil {
		return nil, fmt.Errorf("generate a private key: %w", err)
	}

	keyPEM, err := identity.EncodePrivateKey(key)

	if err != nil {
		return nil, err
	}

	csrPEM, err := createCertificateRequest(key, request.Hostname)

	if err != nil {
		return nil, err
	}

	body, err := json.Marshal(enrollmentRequest{
		Token:           request.Token,
		CSR:             string(csrPEM),
		ProtocolVersion: protocol.Version,
		Hostname:        request.Hostname,
		AgentVersion:    request.AgentVersion,
	})

	if err != nil {
		return nil, fmt.Errorf("encode the enrollment request: %w", err)
	}

	response, err := post(ctx, client, endpoint, body)

	if err != nil {
		return nil, err
	}

	certificatePEM := []byte(response.Certificate)
	chainPEM := []byte(response.CAChain)

	// The server's word is not enough: the certificate must match the key that
	// never left this host, chain to the authority the agent will trust, and
	// carry the identity the server says it assigned.
	leaf, err := identity.VerifyCertificate(
		certificatePEM, keyPEM, chainPEM, response.AgentID, time.Now())

	if err != nil {
		return nil, fmt.Errorf("the issued certificate was refused: %w", err)
	}

	if response.ProtocolVersion != protocol.Version {
		return nil, fmt.Errorf(
			"the server speaks protocol version %d, this agent speaks %d",
			response.ProtocolVersion, protocol.Version)
	}

	metadata := identity.Metadata{
		AgentID:    response.AgentID,
		GatewayURL: response.GatewayURL,
		ServerURL:  request.ServerURL,
		EnrolledAt: time.Now().UTC(),
	}

	// The token is used up at this point and is deliberately not part of what
	// gets written.
	if err := store.Save(keyPEM, certificatePEM, chainPEM, metadata); err != nil {
		return nil, err
	}

	return &Result{
		AgentID:             response.AgentID,
		GatewayURL:          response.GatewayURL,
		CertificateNotAfter: leaf.NotAfter,
	}, nil
}

// CreateCertificateRequest builds a certificate request for an existing key.
//
// It carries no extensions and no meaningful subject: the certificate authority
// decides the identity, and a request that asked for one would be refused.
func CreateCertificateRequest(key *ecdsa.PrivateKey) ([]byte, error) {
	return createCertificateRequest(key, "")
}

func createCertificateRequest(key *ecdsa.PrivateKey, hostname string) ([]byte, error) {
	commonName := hostname

	if commonName == "" {
		commonName = "dockplane-agent"
	}

	template := x509.CertificateRequest{
		Subject:            pkix.Name{CommonName: commonName},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}

	der, err := x509.CreateCertificateRequest(rand.Reader, &template, key)

	if err != nil {
		return nil, fmt.Errorf("create a certificate request: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

func post(ctx context.Context, client *http.Client, endpoint string, body []byte) (*enrollmentResponse, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))

	if err != nil {
		return nil, fmt.Errorf("build the enrollment request: %w", err)
	}

	request.Header.Set("content-type", "application/json")

	response, err := client.Do(request)

	if err != nil {
		return nil, fmt.Errorf("reach the control server: %w", err)
	}

	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))

	if err != nil {
		return nil, fmt.Errorf("read the enrollment response: %w", err)
	}

	if response.StatusCode != http.StatusCreated {
		var failure apiError

		if err := json.Unmarshal(raw, &failure); err == nil && failure.Code != "" {
			return nil, fmt.Errorf("enrollment refused: %s (%s)", failure.Message, failure.Code)
		}

		return nil, fmt.Errorf("enrollment refused with status %d", response.StatusCode)
	}

	var decoded enrollmentResponse

	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("the enrollment response could not be read: %w", err)
	}

	if decoded.AgentID == "" || decoded.Certificate == "" || decoded.GatewayURL == "" {
		return nil, errors.New("the enrollment response was incomplete")
	}

	return &decoded, nil
}
