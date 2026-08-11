// Package identity stores the agent's credential on disk.
//
// The private key never leaves the host and is never transmitted, logged or
// included in an error. Writes are atomic and the key is replaced only after
// the replacement has been proven usable, so an interrupted renewal leaves the
// working identity intact rather than a half-rotated one.
package identity

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// File names inside the state directory.
const (
	keyFile      = "agent.key"
	certFile     = "agent.crt"
	caFile       = "ca.crt"
	metadataFile = "identity.json"
)

// Permissions. The key is owner-only; a key readable by the docker group or by
// anyone else is a second copy of the host's identity.
const (
	DirMode  os.FileMode = 0o700
	KeyMode  os.FileMode = 0o600
	FileMode os.FileMode = 0o644
)

// Errors callers distinguish.
var (
	ErrNotEnrolled = errors.New("no identity stored")
	ErrCorrupt     = errors.New("stored identity is unusable")
)

// Metadata is the non-secret part of an identity.
type Metadata struct {
	AgentID    string    `json:"agentId"`
	GatewayURL string    `json:"gatewayUrl"`
	ServerURL  string    `json:"serverUrl"`
	EnrolledAt time.Time `json:"enrolledAt"`
}

// Identity is a loaded, validated credential.
type Identity struct {
	Metadata    Metadata
	Certificate tls.Certificate
	Leaf        *x509.Certificate
	CAPool      *x509.CertPool
	CAPEM       []byte
}

// Store is the state directory holding the credential.
type Store struct {
	dir string
}

// NewStore addresses a state directory. It is not created until something is
// written, so a read-only command does not leave directories behind.
func NewStore(dir string) *Store {
	return &Store{dir: dir}
}

// Dir reports the state directory.
func (s *Store) Dir() string {
	return s.dir
}

// Path builds a path inside the state directory.
func (s *Store) Path(name string) string {
	return filepath.Join(s.dir, name)
}

// Save writes a complete identity.
//
// Each file is written to a temporary name and renamed into place, so a crash
// mid-write cannot leave a truncated key. The key is written first and the
// metadata last: metadata is what Load keys on, so a partial write is detected
// as "not enrolled" rather than read as a broken identity.
func (s *Store) Save(keyPEM, certPEM, caPEM []byte, metadata Metadata) error {
	if err := os.MkdirAll(s.dir, DirMode); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}

	// A pre-existing directory may be too permissive; tighten it either way.
	if err := os.Chmod(s.dir, DirMode); err != nil {
		return fmt.Errorf("restrict state directory: %w", err)
	}

	if err := writeAtomic(s.Path(keyFile), keyPEM, KeyMode); err != nil {
		return err
	}

	if err := writeAtomic(s.Path(certFile), certPEM, FileMode); err != nil {
		return err
	}

	if len(caPEM) > 0 {
		if err := writeAtomic(s.Path(caFile), caPEM, FileMode); err != nil {
			return err
		}
	}

	encoded, err := json.MarshalIndent(metadata, "", "  ")

	if err != nil {
		return fmt.Errorf("encode identity metadata: %w", err)
	}

	return writeAtomic(s.Path(metadataFile), append(encoded, '\n'), FileMode)
}

// ReplaceCertificate swaps in a renewed certificate.
//
// The key is unchanged, because renewal reuses it only when the caller says so;
// when a new key is supplied both are written, and the certificate is verified
// against the key before either replaces the working pair.
func (s *Store) ReplaceCertificate(keyPEM, certPEM []byte) error {
	if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
		return fmt.Errorf("renewed certificate does not match its key: %w", err)
	}

	if err := writeAtomic(s.Path(keyFile), keyPEM, KeyMode); err != nil {
		return err
	}

	return writeAtomic(s.Path(certFile), certPEM, FileMode)
}

// Load reads and validates the stored identity.
//
// Validation is deliberate rather than trusting the files: a certificate that
// does not match its key, or metadata naming a different agent than the
// certificate does, is a corrupt identity and must fail loudly instead of
// producing a connection that authenticates as something unexpected.
func (s *Store) Load() (*Identity, error) {
	raw, err := os.ReadFile(s.Path(metadataFile))

	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotEnrolled
	}

	if err != nil {
		return nil, fmt.Errorf("read identity metadata: %w", err)
	}

	var metadata Metadata

	if err := json.Unmarshal(raw, &metadata); err != nil {
		return nil, fmt.Errorf("%w: metadata is not readable", ErrCorrupt)
	}

	if metadata.AgentID == "" {
		return nil, fmt.Errorf("%w: metadata names no agent", ErrCorrupt)
	}

	keyPEM, err := os.ReadFile(s.Path(keyFile))

	if err != nil {
		return nil, fmt.Errorf("%w: private key is unreadable", ErrCorrupt)
	}

	certPEM, err := os.ReadFile(s.Path(certFile))

	if err != nil {
		return nil, fmt.Errorf("%w: certificate is unreadable", ErrCorrupt)
	}

	certificate, err := tls.X509KeyPair(certPEM, keyPEM)

	if err != nil {
		return nil, fmt.Errorf("%w: certificate and key do not match", ErrCorrupt)
	}

	leaf, err := x509.ParseCertificate(certificate.Certificate[0])

	if err != nil {
		return nil, fmt.Errorf("%w: certificate is not parseable", ErrCorrupt)
	}

	if leaf.Subject.CommonName != metadata.AgentID {
		return nil, fmt.Errorf("%w: certificate identifies a different agent", ErrCorrupt)
	}

	identity := &Identity{
		Metadata:    metadata,
		Certificate: certificate,
		Leaf:        leaf,
	}

	if caPEM, err := os.ReadFile(s.Path(caFile)); err == nil && len(caPEM) > 0 {
		pool := x509.NewCertPool()

		if pool.AppendCertsFromPEM(caPEM) {
			identity.CAPool = pool
			identity.CAPEM = caPEM
		}
	}

	return identity, nil
}

// CheckPermissions reports state that weakens the credential without preventing
// it from working, so an operator can be warned rather than silently exposed.
func (s *Store) CheckPermissions() []string {
	var findings []string

	if info, err := os.Stat(s.Path(keyFile)); err == nil {
		if info.Mode().Perm()&0o077 != 0 {
			findings = append(findings, fmt.Sprintf(
				"the private key %s is readable beyond its owner (%#o)", s.Path(keyFile), info.Mode().Perm()))
		}
	}

	if info, err := os.Stat(s.dir); err == nil {
		if info.Mode().Perm()&0o077 != 0 {
			findings = append(findings, fmt.Sprintf(
				"the state directory %s is accessible beyond its owner (%#o)", s.dir, info.Mode().Perm()))
		}
	}

	return findings
}

// VerifyCertificate checks a certificate the server issued before it is trusted.
//
// The agent does not take the server's word for its own identity: the
// certificate must chain to the CA the agent will use, match the private key it
// holds, be usable for client authentication and still be valid.
func VerifyCertificate(certPEM, keyPEM, caPEM []byte, expectedAgentID string, now time.Time) (*x509.Certificate, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)

	if err != nil {
		return nil, fmt.Errorf("certificate does not match the private key: %w", err)
	}

	leaf, err := x509.ParseCertificate(pair.Certificate[0])

	if err != nil {
		return nil, fmt.Errorf("certificate is not parseable: %w", err)
	}

	if expectedAgentID != "" && leaf.Subject.CommonName != expectedAgentID {
		return nil, fmt.Errorf(
			"certificate identifies %q rather than the assigned agent", leaf.Subject.CommonName)
	}

	if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
		return nil, fmt.Errorf("certificate is not valid at %s", now.Format(time.RFC3339))
	}

	if !hasClientAuth(leaf) {
		return nil, errors.New("certificate is not usable for client authentication")
	}

	if len(caPEM) > 0 {
		roots := x509.NewCertPool()

		if !roots.AppendCertsFromPEM(caPEM) {
			return nil, errors.New("the issuing authority could not be read")
		}

		intermediates := x509.NewCertPool()

		for _, der := range pair.Certificate[1:] {
			if certificate, err := x509.ParseCertificate(der); err == nil {
				intermediates.AddCert(certificate)
			}
		}

		if _, err := leaf.Verify(x509.VerifyOptions{
			Roots:         roots,
			Intermediates: intermediates,
			CurrentTime:   now,
			KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		}); err != nil {
			return nil, fmt.Errorf("certificate does not chain to the agent authority: %w", err)
		}
	}

	return leaf, nil
}

func hasClientAuth(certificate *x509.Certificate) bool {
	for _, usage := range certificate.ExtKeyUsage {
		if usage == x509.ExtKeyUsageClientAuth || usage == x509.ExtKeyUsageAny {
			return true
		}
	}

	return false
}

// EncodePrivateKey renders a key as PKCS#8 PEM.
func EncodePrivateKey(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)

	if err != nil {
		return nil, fmt.Errorf("encode private key: %w", err)
	}

	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

// writeAtomic writes through a temporary file in the same directory, so the
// rename is atomic and a partial write is never visible under the real name.
func writeAtomic(path string, contents []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)

	temporary, err := os.CreateTemp(directory, filepath.Base(path)+".*")

	if err != nil {
		return fmt.Errorf("create temporary file in %s: %w", directory, err)
	}

	name := temporary.Name()

	defer func() {
		// Removing a file that was renamed already is harmless; leaving one
		// behind after a failure is not.
		_ = os.Remove(name)
	}()

	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return fmt.Errorf("set permissions on %s: %w", name, err)
	}

	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return fmt.Errorf("write %s: %w", name, err)
	}

	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("flush %s: %w", name, err)
	}

	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close %s: %w", name, err)
	}

	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}

	return nil
}
