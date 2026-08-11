package replay_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/dockplane/dockplane/agent/internal/replay"
)

func TestObserveReportsARepeatedIdentifier(t *testing.T) {
	cache := replay.New(16, time.Minute)

	if cache.Observe("request-1") {
		t.Fatal("a first sighting must not be reported as seen")
	}

	if !cache.Observe("request-1") {
		t.Fatal("a repeated identifier must be reported as seen")
	}
}

func TestCacheStaysBounded(t *testing.T) {
	const capacity = 8

	cache := replay.New(capacity, time.Minute)

	for index := range 100 {
		cache.Observe(fmt.Sprintf("request-%d", index))
	}

	if length := cache.Len(); length > capacity {
		t.Fatalf("cache holds %d entries, want at most %d", length, capacity)
	}
}

func TestTheOldestIdentifierIsForgottenFirst(t *testing.T) {
	cache := replay.New(2, time.Minute)

	cache.Observe("first")
	cache.Observe("second")
	cache.Observe("third")

	if cache.Observe("first") {
		t.Error("the oldest identifier should have been evicted")
	}

	if !cache.Observe("third") {
		t.Error("the newest identifier should still be remembered")
	}
}

func TestIdentifiersExpire(t *testing.T) {
	cache := replay.New(16, 10*time.Millisecond)

	cache.Observe("request-1")

	time.Sleep(20 * time.Millisecond)

	if cache.Observe("request-1") {
		t.Fatal("an expired identifier should no longer be remembered")
	}
}
