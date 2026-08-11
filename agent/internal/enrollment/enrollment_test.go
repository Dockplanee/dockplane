package enrollment_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/enrollment"
	"github.com/dockplane/dockplane/agent/internal/identity"
)

const testToken = "TOKEN-do-not-persist-me-0123456789"

// authority signs agent certificates the way the control server's CA does.
type authority struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
}

func newAuthority(t *testing.T) *authority {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	if err != nil {
		t.Fatalf("generate authority key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Agent CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)

	if err != nil {
		t.Fatalf("create authority: %v", err)
	}

	certificate, err := x509.ParseCertificate(der)

	if err != nil {
		t.Fatalf("parse authority: %v", err)
	}

	return &authority{
		certificate: certificate,
		key:         key,
		pem:         pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
	}
}

// sign issues a certificate for the public key inside a certificate request,
// with the subject the server chose rather than the one that was asked for.
func (a *authority) sign(t *testing.T, csrPEM string, agentID string) string {
	t.Helper()

	block, _ := pem.Decode([]byte(csrPEM))

	if block == nil {
		t.Fatal("the certificate request was not PEM")
	}

	csr, err := x509.ParseCertificateRequest(block.Bytes)

	if err != nil {
		t.Fatalf("parse certificate request: %v", err)
	}

	if err := csr.CheckSignature(); err != nil {
		t.Fatalf("the certificate request was not self-signed: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: agentID},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(30 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, template, a.certificate, csr.PublicKey, a.key)

	if err != nil {
		t.Fatalf("issue certificate: %v", err)
	}

	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// server stands in for the control server's enrollment endpoint.
func server(t *testing.T, ca *authority, agentID string) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token           string `json:"token"`
			CSR             string `json:"csr"`
			ProtocolVersion int    `json:"protocolVersion"`
		}

		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		if body.Token != testToken {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"code": "ENROLLMENT_TOKEN_INVALID", "message": "no",
			})

			return
		}

		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusCreated)

		_ = json.NewEncoder(w).Encode(map[string]any{
			"agentId":             agentID,
			"certificate":         ca.sign(t, body.CSR, agentID),
			"caChain":             string(ca.pem),
			"gatewayUrl":          "https://dockplane.example.com:9443",
			"protocolVersion":     1,
			"certificateNotAfter": time.Now().Add(30 * 24 * time.Hour).Format(time.RFC3339),
		})
	}))
}

func TestEnrollStoresAUsableIdentity(t *testing.T) {
	ca := newAuthority(t)
	const agentID = "6a2f1f6e-9a0e-4a1a-9e4c-2b7a1f0c3d55"

	control := server(t, ca, agentID)
	defer control.Close()

	directory := t.TempDir()
	store := identity.NewStore(directory)

	result, err := enrollment.Enroll(context.Background(), store, control.Client(), enrollment.Request{
		ServerURL: control.URL,
		Token:     testToken,
		Hostname:  "docker-01",
	})

	if err != nil {
		t.Fatalf("enroll: %v", err)
	}

	if result.AgentID != agentID {
		t.Errorf("agent id = %q, want %q", result.AgentID, agentID)
	}

	credential, err := store.Load()

	if err != nil {
		t.Fatalf("the stored identity is not loadable: %v", err)
	}

	if credential.Leaf.Subject.CommonName != agentID {
		t.Errorf("certificate names %q, want %q", credential.Leaf.Subject.CommonName, agentID)
	}
}

func TestEnrollDoesNotPersistTheToken(t *testing.T) {
	ca := newAuthority(t)
	const agentID = "6a2f1f6e-9a0e-4a1a-9e4c-2b7a1f0c3d55"

	control := server(t, ca, agentID)
	defer control.Close()

	directory := t.TempDir()
	store := identity.NewStore(directory)

	if _, err := enrollment.Enroll(context.Background(), store, control.Client(), enrollment.Request{
		ServerURL: control.URL,
		Token:     testToken,
		Hostname:  "docker-01",
	}); err != nil {
		t.Fatalf("enroll: %v", err)
	}

	entries, err := os.ReadDir(directory)

	if err != nil {
		t.Fatalf("read state directory: %v", err)
	}

	for _, item := range entries {
		contents, err := os.ReadFile(filepath.Join(directory, item.Name()))

		if err != nil {
			t.Fatalf("read %s: %v", item.Name(), err)
		}

		if strings.Contains(string(contents), testToken) {
			t.Fatalf("%s persisted the enrollment token", item.Name())
		}
	}
}

func TestEnrollRefusesACertificateFromAnotherAuthority(t *testing.T) {
	// The response is well formed and names the right agent, but the chain does
	// not match the bundle the agent is told to trust.
	real := newAuthority(t)
	imposter := newAuthority(t)

	const agentID = "6a2f1f6e-9a0e-4a1a-9e4c-2b7a1f0c3d55"

	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CSR string `json:"csr"`
		}

		_ = json.NewDecoder(r.Body).Decode(&body)

		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusCreated)

		_ = json.NewEncoder(w).Encode(map[string]any{
			"agentId":         agentID,
			"certificate":     imposter.sign(t, body.CSR, agentID),
			"caChain":         string(real.pem),
			"gatewayUrl":      "https://dockplane.example.com:9443",
			"protocolVersion": 1,
		})
	}))

	defer control.Close()

	store := identity.NewStore(t.TempDir())

	_, err := enrollment.Enroll(context.Background(), store, control.Client(), enrollment.Request{
		ServerURL: control.URL,
		Token:     testToken,
	})

	if err == nil {
		t.Fatal("expected a certificate that does not chain to the given authority to be refused")
	}

	if _, err := store.Load(); err == nil {
		t.Fatal("a refused certificate must not have been stored")
	}
}

func TestEnrollReportsARefusedToken(t *testing.T) {
	ca := newAuthority(t)

	control := server(t, ca, "unused")
	defer control.Close()

	store := identity.NewStore(t.TempDir())

	_, err := enrollment.Enroll(context.Background(), store, control.Client(), enrollment.Request{
		ServerURL: control.URL,
		Token:     "wrong-token",
	})

	if err == nil || !strings.Contains(err.Error(), "ENROLLMENT_TOKEN_INVALID") {
		t.Fatalf("error = %v, want the server's refusal", err)
	}
}

func TestEnrollRequiresAToken(t *testing.T) {
	store := identity.NewStore(t.TempDir())

	if _, err := enrollment.Enroll(context.Background(), store, http.DefaultClient, enrollment.Request{
		ServerURL: "https://dockplane.example.com",
	}); err == nil {
		t.Fatal("expected enrollment without a token to be refused")
	}
}
