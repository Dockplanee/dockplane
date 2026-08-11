// Package metrics takes a point-in-time reading of a host.
//
// A snapshot, not a time series. Dockplane stores the latest reading and the
// moment it was taken; building a metrics database inside the agent would be a
// different product, and a far larger blast radius on every managed host.
package metrics

import (
	"context"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
)

// Snapshot is one reading.
//
// Every value is a pointer or carries its own presence, so a metric that could
// not be read is absent rather than reported as zero. A host with an unreadable
// filesystem must not look like a host with an empty disk.
type Snapshot struct {
	CPUPercent       *float64     `json:"cpuPercent,omitempty"`
	MemoryUsedBytes  *uint64      `json:"memoryUsedBytes,omitempty"`
	MemoryTotalBytes *uint64      `json:"memoryTotalBytes,omitempty"`
	DiskUsedBytes    *uint64      `json:"diskUsedBytes,omitempty"`
	DiskTotalBytes   *uint64      `json:"diskTotalBytes,omitempty"`
	LoadAverage      *LoadAverage `json:"loadAverage,omitempty"`
	// Unavailable names the sources that could not be read, so a partial
	// snapshot is visibly partial instead of quietly incomplete.
	Unavailable []string  `json:"unavailable,omitempty"`
	ObservedAt  time.Time `json:"observedAt"`
}

// LoadAverage is the usual triple, where the platform provides it.
type LoadAverage struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
}

// Collector reads host metrics.
type Collector struct {
	// Mountpoint is the filesystem reported. The root filesystem is what fills
	// up and stops Docker.
	Mountpoint string
	// SampleWindow is how long CPU utilisation is measured over. A zero window
	// would report utilisation since boot, which is not an operational signal.
	SampleWindow time.Duration
	now          func() time.Time
}

// NewCollector builds a collector with sensible defaults.
func NewCollector() *Collector {
	return &Collector{Mountpoint: "/", SampleWindow: time.Second, now: time.Now}
}

// Collect takes a snapshot.
//
// A failure in one source is recorded and collection continues. Losing every
// metric because one of them is unavailable would take a host out of view for a
// reason that has nothing to do with Docker.
func (c *Collector) Collect(ctx context.Context) Snapshot {
	snapshot := Snapshot{ObservedAt: c.now().UTC()}

	if percentages, err := cpu.PercentWithContext(ctx, c.SampleWindow, false); err == nil && len(percentages) > 0 {
		value := percentages[0]
		snapshot.CPUPercent = &value
	} else {
		snapshot.Unavailable = append(snapshot.Unavailable, "cpu")
	}

	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		used := memory.Used
		total := memory.Total
		snapshot.MemoryUsedBytes = &used
		snapshot.MemoryTotalBytes = &total
	} else {
		snapshot.Unavailable = append(snapshot.Unavailable, "memory")
	}

	if usage, err := disk.UsageWithContext(ctx, c.Mountpoint); err == nil {
		used := usage.Used
		total := usage.Total
		snapshot.DiskUsedBytes = &used
		snapshot.DiskTotalBytes = &total
	} else {
		snapshot.Unavailable = append(snapshot.Unavailable, "filesystem")
	}

	if averages, err := load.AvgWithContext(ctx); err == nil {
		snapshot.LoadAverage = &LoadAverage{
			One:     averages.Load1,
			Five:    averages.Load5,
			Fifteen: averages.Load15,
		}
	} else {
		snapshot.Unavailable = append(snapshot.Unavailable, "load")
	}

	return snapshot
}
