package identity_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/identity"
)

// issue builds a small certificate authority and one agent certificate, which
// is what the control server would have produced.
func issue(t *testing.T, commonName string, notAfter time.Time, usages []x509.ExtKeyUsage) (certPEM, keyPEM, caPEM []byte) {
	t.Helper()

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	if err != nil {
		t.Fatalf("generate authority key: %v", err)
	}

	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Agent CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}

	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)

	if err != nil {
		t.Fatalf("create authority: %v", err)
	}

	authority, err := x509.ParseCertificate(caDER)

	if err != nil {
		t.Fatalf("parse authority: %v", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	if err != nil {
		t.Fatalf("generate agent key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usages,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, authority, &key.PublicKey, caKey)

	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}

	encodedKey, err := identity.EncodePrivateKey(key)

	if err != nil {
		t.Fatalf("encode key: %v", err)
	}

	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		encodedKey,
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
}

func clientAuth() []x509.ExtKeyUsage {
	return []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
}

func TestSaveWritesRestrictivePermissions(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	store := identity.NewStore(directory)

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{AgentID: "agent-1"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	keyInfo, err := os.Stat(filepath.Join(directory, "agent.key"))

	if err != nil {
		t.Fatalf("stat key: %v", err)
	}

	if perm := keyInfo.Mode().Perm(); perm != 0o600 {
		t.Errorf("private key mode = %#o, want 0600", perm)
	}

	directoryInfo, err := os.Stat(directory)

	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}

	if perm := directoryInfo.Mode().Perm(); perm != 0o700 {
		t.Errorf("state directory mode = %#o, want 0700", perm)
	}
}

func TestSaveDoesNotPersistTheEnrollmentToken(t *testing.T) {
	directory := t.TempDir()
	store := identity.NewStore(directory)

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	const token = "TOKEN-c2VjcmV0LXZhbHVl-do-not-store"

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{
		AgentID:   "agent-1",
		ServerURL: "https://dockplane.example.com",
	}); err != nil {
		t.Fatalf("save: %v", err)
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

		if strings.Contains(string(contents), token) {
			t.Errorf("%s contains the enrollment token", item.Name())
		}
	}
}

func TestLoadReturnsNotEnrolledForAnEmptyDirectory(t *testing.T) {
	store := identity.NewStore(t.TempDir())

	if _, err := store.Load(); !errors.Is(err, identity.ErrNotEnrolled) {
		t.Fatalf("load error = %v, want ErrNotEnrolled", err)
	}
}

func TestLoadRejectsACertificateThatDoesNotMatchTheKey(t *testing.T) {
	directory := t.TempDir()
	store := identity.NewStore(directory)

	certPEM, _, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())
	_, otherKeyPEM, _ := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(otherKeyPEM, certPEM, caPEM, identity.Metadata{AgentID: "agent-1"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	if _, err := store.Load(); !errors.Is(err, identity.ErrCorrupt) {
		t.Fatalf("load error = %v, want ErrCorrupt", err)
	}
}

func TestLoadRejectsMetadataNamingAnotherAgent(t *testing.T) {
	store := identity.NewStore(t.TempDir())

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{AgentID: "someone-else"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	if _, err := store.Load(); !errors.Is(err, identity.ErrCorrupt) {
		t.Fatalf("load error = %v, want ErrCorrupt", err)
	}
}

func TestReplaceCertificateRefusesAMismatchedPair(t *testing.T) {
	directory := t.TempDir()
	store := identity.NewStore(directory)

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{AgentID: "agent-1"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	replacementCert, _, _ := issue(t, "agent-1", time.Now().Add(2*time.Hour), clientAuth())
	_, unrelatedKey, _ := issue(t, "agent-1", time.Now().Add(2*time.Hour), clientAuth())

	if err := store.ReplaceCertificate(unrelatedKey, replacementCert); err == nil {
		t.Fatal("expected a mismatched pair to be refused")
	}

	// The working identity must survive a refused rotation.
	loaded, err := store.Load()

	if err != nil {
		t.Fatalf("the original identity was damaged: %v", err)
	}

	if loaded.Metadata.AgentID != "agent-1" {
		t.Errorf("agent id = %q, want agent-1", loaded.Metadata.AgentID)
	}
}

func TestReplaceCertificateSwapsAtomically(t *testing.T) {
	directory := t.TempDir()
	store := identity.NewStore(directory)

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{AgentID: "agent-1"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	before, err := store.Load()

	if err != nil {
		t.Fatalf("load: %v", err)
	}

	renewedCert, renewedKey, _ := issue(t, "agent-1", time.Now().Add(48*time.Hour), clientAuth())

	if err := store.ReplaceCertificate(renewedKey, renewedCert); err != nil {
		t.Fatalf("replace: %v", err)
	}

	after, err := store.Load()

	if err != nil {
		t.Fatalf("load after replace: %v", err)
	}

	if !after.Leaf.NotAfter.After(before.Leaf.NotAfter) {
		t.Error("the renewed certificate did not replace the previous one")
	}

	if after.Metadata.AgentID != before.Metadata.AgentID {
		t.Error("the identity changed during renewal")
	}

	info, err := os.Stat(filepath.Join(directory, "agent.key"))

	if err != nil {
		t.Fatalf("stat key: %v", err)
	}

	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("private key mode after rotation = %#o, want 0600", perm)
	}
}

func TestCheckPermissionsReportsAWorldReadableKey(t *testing.T) {
	directory := t.TempDir()
	store := identity.NewStore(directory)

	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if err := store.Save(keyPEM, certPEM, caPEM, identity.Metadata{AgentID: "agent-1"}); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := os.Chmod(filepath.Join(directory, "agent.key"), 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	findings := store.CheckPermissions()

	if len(findings) == 0 {
		t.Fatal("expected a finding for a world-readable private key")
	}
}

func TestVerifyCertificateRejectsAForeignAuthority(t *testing.T) {
	certPEM, keyPEM, _ := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())
	_, _, foreignCA := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if _, err := identity.VerifyCertificate(certPEM, keyPEM, foreignCA, "agent-1", time.Now()); err == nil {
		t.Fatal("expected a certificate from another authority to be refused")
	}
}

func TestVerifyCertificateRejectsAnUnexpectedIdentity(t *testing.T) {
	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour), clientAuth())

	if _, err := identity.VerifyCertificate(certPEM, keyPEM, caPEM, "agent-2", time.Now()); err == nil {
		t.Fatal("expected a certificate naming another agent to be refused")
	}
}

func TestVerifyCertificateRejectsOneWithoutClientAuth(t *testing.T) {
	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Hour),
		[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth})

	if _, err := identity.VerifyCertificate(certPEM, keyPEM, caPEM, "agent-1", time.Now()); err == nil {
		t.Fatal("expected a certificate without client authentication to be refused")
	}
}

func TestVerifyCertificateRejectsAnExpiredCertificate(t *testing.T) {
	certPEM, keyPEM, caPEM := issue(t, "agent-1", time.Now().Add(time.Minute), clientAuth())

	future := time.Now().Add(time.Hour)

	if _, err := identity.VerifyCertificate(certPEM, keyPEM, caPEM, "agent-1", future); err == nil {
		t.Fatal("expected an expired certificate to be refused")
	}
}
