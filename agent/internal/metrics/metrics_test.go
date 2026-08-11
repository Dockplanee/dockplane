package metrics_test

import (
	"context"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/metrics"
)

func TestCollectReturnsASnapshot(t *testing.T) {
	collector := metrics.NewCollector()
	collector.SampleWindow = 10 * time.Millisecond

	snapshot := collector.Collect(context.Background())

	if snapshot.ObservedAt.IsZero() {
		t.Fatal("the snapshot carries no observation time")
	}

	if snapshot.MemoryTotalBytes == nil || *snapshot.MemoryTotalBytes == 0 {
		t.Error("memory was not reported")
	}
}

func TestAnUnreadableFilesystemDoesNotFailTheSnapshot(t *testing.T) {
	collector := metrics.NewCollector()
	collector.SampleWindow = 10 * time.Millisecond
	collector.Mountpoint = "/this/path/does/not/exist"

	snapshot := collector.Collect(context.Background())

	if snapshot.DiskTotalBytes != nil {
		t.Error("an unreadable filesystem must not report a size")
	}

	found := false

	for _, source := range snapshot.Unavailable {
		if source == "filesystem" {
			found = true
		}
	}

	if !found {
		t.Fatalf("unavailable = %v, want it to name the filesystem", snapshot.Unavailable)
	}

	// The rest of the snapshot must still be usable: one missing source is not
	// a reason to lose sight of the host.
	if snapshot.MemoryTotalBytes == nil {
		t.Error("memory was lost along with the filesystem")
	}
}
