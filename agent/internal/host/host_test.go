package host_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/host"
)

func TestInventoryReportsTheOperatingContext(t *testing.T) {
	inventory := host.NewCollector("1.2.3").Inventory(context.Background(), "29.0.0")

	if inventory.Hostname == "" {
		t.Error("hostname was not reported")
	}

	if inventory.Architecture == "" {
		t.Error("architecture was not reported")
	}

	if inventory.CPUCount < 1 {
		t.Errorf("cpu count = %d, want at least 1", inventory.CPUCount)
	}

	if inventory.AgentVersion != "1.2.3" {
		t.Errorf("agent version = %q, want 1.2.3", inventory.AgentVersion)
	}

	if inventory.DockerVersion != "29.0.0" {
		t.Errorf("docker version = %q, want 29.0.0", inventory.DockerVersion)
	}

	if inventory.ObservedAt.IsZero() {
		t.Error("the inventory carries no observation time")
	}
}

// The inventory is a fixed set of operational facts. Anything resembling an
// environment dump or a process listing would be a collection-scope change.
func TestInventoryCarriesOnlyTheDeclaredFields(t *testing.T) {
	inventory := host.NewCollector("1.2.3").Inventory(context.Background(), "")

	encoded, err := json.Marshal(inventory)

	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	var fields map[string]any

	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatalf("decode: %v", err)
	}

	allowed := map[string]bool{
		"hostname": true, "os": true, "osVersion": true, "architecture": true,
		"kernel": true, "uptimeSeconds": true, "cpuCount": true, "cpuModel": true,
		"memoryTotalBytes": true, "dockerVersion": true, "agentVersion": true,
		"observedAt": true,
	}

	for name := range fields {
		if !allowed[name] {
			t.Errorf("the inventory reports an undeclared field: %s", name)
		}
	}

	if strings.Contains(strings.ToLower(string(encoded)), "environ") {
		t.Error("the inventory appears to carry environment data")
	}
}
