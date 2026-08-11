// Package host reports the operating context of the Docker host.
//
// Collection is deliberately narrow. The agent reports what an operator needs
// to run Docker on a machine — its identity, size and kernel — and nothing
// about what else lives there. It does not read environment blocks, process
// command lines, SSH configuration, home directories or arbitrary files.
package host

import (
	"context"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

// Inventory is the slow-changing description of a host.
type Inventory struct {
	Hostname         string    `json:"hostname"`
	OS               string    `json:"os,omitempty"`
	OSVersion        string    `json:"osVersion,omitempty"`
	Architecture     string    `json:"architecture"`
	Kernel           string    `json:"kernel,omitempty"`
	UptimeSeconds    uint64    `json:"uptimeSeconds"`
	CPUCount         int       `json:"cpuCount"`
	CPUModel         string    `json:"cpuModel,omitempty"`
	MemoryTotalBytes uint64    `json:"memoryTotalBytes"`
	DockerVersion    string    `json:"dockerVersion,omitempty"`
	AgentVersion     string    `json:"agentVersion"`
	ObservedAt       time.Time `json:"observedAt"`
}

// Collector gathers host facts.
type Collector struct {
	agentVersion string
	now          func() time.Time
}

// NewCollector builds a collector for the given agent build.
func NewCollector(agentVersion string) *Collector {
	return &Collector{agentVersion: agentVersion, now: time.Now}
}

/*
Inventory collects what is available.

A source that fails leaves its field empty rather than failing the whole
collection. A host whose kernel version cannot be read is still a host worth
reporting, and an agent that refused to report anything would look identical to
one that had gone away.
*/
func (c *Collector) Inventory(ctx context.Context, dockerVersion string) Inventory {
	inventory := Inventory{
		Architecture:  runtime.GOARCH,
		CPUCount:      runtime.NumCPU(),
		DockerVersion: dockerVersion,
		AgentVersion:  c.agentVersion,
		ObservedAt:    c.now().UTC(),
	}

	if information, err := host.InfoWithContext(ctx); err == nil {
		inventory.Hostname = information.Hostname
		inventory.OS = information.Platform
		inventory.OSVersion = information.PlatformVersion
		inventory.Kernel = information.KernelVersion
		inventory.UptimeSeconds = information.Uptime

		if information.KernelArch != "" {
			inventory.Architecture = information.KernelArch
		}
	}

	if counts, err := cpu.CountsWithContext(ctx, true); err == nil && counts > 0 {
		inventory.CPUCount = counts
	}

	if information, err := cpu.InfoWithContext(ctx); err == nil && len(information) > 0 {
		inventory.CPUModel = information[0].ModelName
	}

	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		inventory.MemoryTotalBytes = memory.Total
	}

	return inventory
}
