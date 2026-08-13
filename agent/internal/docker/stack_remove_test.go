package docker_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Removing the containers of a stack.

The destructive path, so the tests are mostly about what it refuses to do. A
host that does not say clearly which containers are the stack's is one where
nothing may be removed at all, and the check for that has to happen before the
first removal rather than during it — a half-removed stack cannot be undone.

The rule with no exception is the volumes. Every removal below is checked for
having asked Docker to keep them.
*/

func TestRemoveStackTakesAwayWhatDependsOnSomethingFirst(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	result, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if err != nil {
		t.Fatalf("remove: %v", err)
	}

	if result.Outcome != docker.RemoveCompleted {
		t.Fatalf("outcome: %s", result.Outcome)
	}

	if got := strings.Join(host.ops, " "); got != "stop:shop-web-1 remove:shop-web-1 stop:shop-db-1 remove:shop-db-1" {
		t.Fatalf("the stack was not taken down in reverse dependency order: %s", got)
	}

	if len(host.containers) != 0 {
		t.Fatalf("containers are left: %d", len(host.containers))
	}

	// The rule with no exception.
	if host.removedVolumes {
		t.Fatal("a removal asked Docker to take the volumes with it")
	}
}

/* A service that is already stopped is removed without being stopped again. */
func TestRemoveStackDoesNotStopWhatIsAlreadyStopped(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-db-1").running = false

	if _, err := docker.NewEngine(host).RemoveStack(context.Background(), plan); err != nil {
		t.Fatalf("remove: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "stop:shop-web-1 remove:shop-web-1 remove:shop-db-1" {
		t.Fatalf("unexpected sequence: %s", got)
	}
}

func TestRemoveStackRefusesWhenAServiceIsMissing(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	delete(host.containers, host.byName("shop-db-1").id)

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackServiceMissing) {
		t.Fatalf("expected a missing service, got %v", err)
	}

	// Nothing at all: the service that is there was not removed on the way to
	// finding out that the other one is gone.
	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}

	if host.byName("shop-web-1") == nil {
		t.Fatal("a container was removed before the check completed")
	}
}

func TestRemoveStackRefusesTwoContainersClaimingOneService(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.seedService(deployedRevision, "web", "resource-web", "shop-web-2")

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/*
Identity, never the name.

A container called what one of ours is called, carrying somebody else's
identity, is somebody else's container — and this is the operation that would
otherwise destroy it.
*/
func TestRemoveStackRefusesAContainerWithAnotherIdentity(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-web-1").labels[docker.LabelContainerID] = "resource-somebody-else"

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/* A container of this stack the operation does not cover means it is not understood. */
func TestRemoveStackRefusesAServiceItDoesNotCover(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.seedService(deployedRevision, "cache", "resource-cache", "shop-cache-1")

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/*
A removal that stopped partway says which containers are gone.

Nothing is rebuilt. Recreating one would mean inventing a configuration this
path never reads, and a host that has just refused an instruction is not one to
send more of them to.
*/
func TestRemoveStackReportsWhatItRemovedWhenOneWillNotGo(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.wontRemove[deployedRevision+"/db"] = true

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackRemoveIncomplete) {
		t.Fatalf("expected an incomplete removal, got %v", err)
	}

	var incomplete *docker.StackRemoveIncompleteError

	if !errors.As(err, &incomplete) {
		t.Fatalf("the failure does not carry what it removed: %v", err)
	}

	if incomplete.Result.Outcome != docker.RemovePartial {
		t.Fatalf("outcome: %s", incomplete.Result.Outcome)
	}

	if len(incomplete.Result.Removed) != 1 || incomplete.Result.Removed[0].ServiceName != "web" {
		t.Fatalf("removed: %+v", incomplete.Result.Removed)
	}

	if incomplete.Result.FailedService != "db" {
		t.Fatalf("failed service: %s", incomplete.Result.FailedService)
	}

	if host.byName("shop-web-1") != nil {
		t.Fatal("the service that was removed came back")
	}

	if host.removedVolumes {
		t.Fatal("a failed removal asked Docker to take the volumes with it")
	}
}

/* A removal that fails on its first service leaves the stack exactly as it was. */
func TestRemoveStackThatFailsFirstChangesNothing(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.wontRemove[deployedRevision+"/web"] = true

	_, err := docker.NewEngine(host).RemoveStack(context.Background(), plan)

	if errors.Is(err, docker.ErrStackRemoveIncomplete) {
		t.Fatalf("a removal that removed nothing was reported as partial: %v", err)
	}

	if err == nil {
		t.Fatal("a removal that failed was reported as a success")
	}

	if host.byName("shop-db-1") == nil {
		t.Fatal("the service behind the failed one was removed anyway")
	}
}
