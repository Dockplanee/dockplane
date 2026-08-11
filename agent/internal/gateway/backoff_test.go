package gateway

import (
	"testing"
	"time"
)

func TestBackoffGrowsAndStaysBounded(t *testing.T) {
	previous := time.Duration(0)

	for attempt := range 20 {
		delay := backoff(attempt)

		if delay < initialBackoff {
			t.Fatalf("attempt %d: delay %s is below the floor %s", attempt, delay, initialBackoff)
		}

		// The ceiling is what keeps a long outage from turning into an hours-long
		// wait once the server returns. Jitter may exceed it slightly by design.
		ceiling := maxBackoff + time.Duration(float64(maxBackoff)*jitterFraction)

		if delay > ceiling {
			t.Fatalf("attempt %d: delay %s exceeds the ceiling %s", attempt, delay, ceiling)
		}

		if attempt < 5 && attempt > 0 && delay < previous/2 {
			t.Fatalf("attempt %d: delay %s did not grow from %s", attempt, delay, previous)
		}

		previous = delay
	}
}

func TestBackoffIsJittered(t *testing.T) {
	seen := make(map[time.Duration]bool)

	for range 50 {
		seen[backoff(6)] = true
	}

	// Without jitter every attempt at the same step would produce one value, and
	// a fleet would return to a recovering server in lockstep.
	if len(seen) < 5 {
		t.Fatalf("got %d distinct delays across 50 samples, expected jitter", len(seen))
	}
}

func TestBackoffHandlesALargeAttemptCount(t *testing.T) {
	if delay := backoff(1000); delay <= 0 {
		t.Fatalf("delay = %s, want a positive bounded value", delay)
	}
}
