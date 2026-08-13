package docker_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/dockplane/dockplane/agent/internal/docker"
)

/*
Starting, stopping and restarting a deployed stack.

The same model of a host the apply tests use, so what is asserted here is read
back out of it rather than out of a recorded call. Two things get the most
scrutiny: the order services are moved in, because a database taken away from
something still writing to it is a data problem rather than an availability one,
and what happens when the host does not say clearly which containers are the
stack's — where the only safe answer is to do nothing at all.
*/

const deployedRevision = "revision-1"

/** A stack of two services on a host, web depending on db, both running. */
func deployedStack(host *fakeHost) *docker.StackLifecyclePlan {
	host.seedService(deployedRevision, "db", "resource-db", "shop-db-1")
	host.seedService(deployedRevision, "web", "resource-web", "shop-web-1")

	return &docker.StackLifecyclePlan{
		PlanVersion: docker.StackLifecyclePlanVersion,
		StackID:     "stack-1",
		RevisionID:  deployedRevision,
		Services: []docker.StackLifecycleService{
			{ServiceName: "db", ContainerID: "resource-db"},
			{ServiceName: "web", ContainerID: "resource-web", DependsOn: []string{"db"}},
		},
	}
}

func TestStopStackStopsWhatDependsOnSomethingFirst(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	result, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if err != nil {
		t.Fatalf("stop: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "stop:shop-web-1 stop:shop-db-1" {
		t.Fatalf("services were stopped in the wrong order: %s", got)
	}

	if result.Outcome != docker.LifecycleCompleted {
		t.Fatalf("outcome: %s", result.Outcome)
	}

	for _, service := range result.Services {
		if service.State != "exited" {
			t.Fatalf("%s is %s", service.ServiceName, service.State)
		}
	}
}

func TestStartStackStartsWhatIsDependedOnFirst(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	for _, found := range host.containers {
		found.running = false
	}

	if _, err := docker.NewEngine(host).StartStack(context.Background(), plan); err != nil {
		t.Fatalf("start: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "start:shop-db-1 start:shop-web-1" {
		t.Fatalf("services were started in the wrong order: %s", got)
	}
}

/* A stack is running when its services are running, however they got there. */
func TestStartStackLeavesAServiceThatIsAlreadyRunning(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-db-1").running = false

	if _, err := docker.NewEngine(host).StartStack(context.Background(), plan); err != nil {
		t.Fatalf("start: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "start:shop-db-1" {
		t.Fatalf("a running service was touched: %s", got)
	}
}

func TestStopStackLeavesAServiceThatIsAlreadyStopped(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-web-1").running = false

	if _, err := docker.NewEngine(host).StopStack(context.Background(), plan); err != nil {
		t.Fatalf("stop: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "stop:shop-db-1" {
		t.Fatalf("a stopped service was touched: %s", got)
	}
}

/*
A restart is the stop sequence and then the start sequence.

Not a Docker restart per container: those would overlap, and web would spend the
window talking to a database on its way down.
*/
func TestRestartStackTakesTheStackDownAndBringsItBackUp(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	before := map[string]string{}

	for _, found := range host.containers {
		found.startedAt = "2025-12-31T00:00:00Z"
		before[found.name] = found.id
	}

	result, err := docker.NewEngine(host).RestartStack(context.Background(), plan)

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	if got := strings.Join(host.ops, " "); got != "stop:shop-web-1 stop:shop-db-1 start:shop-db-1 start:shop-web-1" {
		t.Fatalf("the restart did not follow the dependency order: %s", got)
	}

	for _, service := range result.Services {
		if service.State != "running" {
			t.Fatalf("%s is %s", service.ServiceName, service.State)
		}

		// Nothing is recreated, so the container an operator is looking at is
		// the same one afterwards.
		if service.DockerID != before[containerNameOf(host, service.DockerID)] {
			t.Fatalf("%s changed its Docker identifier", service.ServiceName)
		}

		if service.StartedAt == "2025-12-31T00:00:00Z" || service.StartedAt == "" {
			t.Fatalf("%s does not report when it was started: %q", service.ServiceName, service.StartedAt)
		}
	}
}

/* A service that is stopped when a restart begins is running when it ends. */
func TestRestartStackBringsUpAServiceThatWasStopped(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-db-1").running = false

	result, err := docker.NewEngine(host).RestartStack(context.Background(), plan)

	if err != nil {
		t.Fatalf("restart: %v", err)
	}

	for _, service := range result.Services {
		if service.State != "running" {
			t.Fatalf("%s is %s", service.ServiceName, service.State)
		}
	}
}

/*
Nothing is created to make an operation possible.

A service whose container is gone is a stack that is not what the server thinks
it is. Starting it would mean building one, and building belongs to deploying a
revision, where the configuration to build from is known.
*/
func TestLifecycleRefusesWhenAServiceIsMissing(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	delete(host.containers, host.byName("shop-db-1").id)

	_, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackServiceMissing) {
		t.Fatalf("expected a missing service, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

func TestLifecycleRefusesTwoContainersClaimingOneService(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.seedService(deployedRevision, "web", "resource-web", "shop-web-2")

	_, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/* Identity, not name. A container carrying somebody else's is not ours to stop. */
func TestLifecycleRefusesAContainerWithAnotherIdentity(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-web-1").labels[docker.LabelContainerID] = "resource-somebody-else"

	_, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/*
The revision has to be the one the operation is for.

A container running another revision means the server and the host disagree
about what is deployed, and a lifecycle operation is not the thing that resolves
a disagreement about configuration.
*/
func TestLifecycleRefusesAServiceRunningAnotherRevision(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.byName("shop-web-1").labels[docker.LabelStackRevisionID] = "revision-2"

	_, err := docker.NewEngine(host).StartStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/* A stack holding more services than the server expects is not understood. */
func TestLifecycleRefusesAServiceTheOperationDoesNotCover(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.seedService(deployedRevision, "cache", "resource-cache", "shop-cache-1")

	_, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackStateAmbiguous) {
		t.Fatalf("expected an ambiguous host, got %v", err)
	}

	if len(host.ops) != 0 {
		t.Fatalf("the host was changed: %v", host.ops)
	}
}

/*
A stop that only half worked says so, and nothing is started again to hide it.

Putting the stack back up would be a mutation nobody asked for, on top of a host
that has just demonstrated it does not do what it is told.
*/
func TestStopStackReportsWhatItManagedWhenAServiceWillNotStop(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	host.wontStop[deployedRevision+"/db"] = true

	_, err := docker.NewEngine(host).StopStack(context.Background(), plan)

	if !errors.Is(err, docker.ErrStackLifecycleIncomplete) {
		t.Fatalf("expected an incomplete stop, got %v", err)
	}

	var incomplete *docker.StackLifecycleIncompleteError

	if !errors.As(err, &incomplete) {
		t.Fatalf("the failure does not carry what it managed: %v", err)
	}

	if incomplete.Result.Outcome != docker.LifecyclePartial {
		t.Fatalf("outcome: %s", incomplete.Result.Outcome)
	}

	if incomplete.Result.FailedService != "db" {
		t.Fatalf("failed service: %s", incomplete.Result.FailedService)
	}

	if host.byName("shop-web-1").running {
		t.Fatal("the service that stopped was started again")
	}

	if !host.byName("shop-db-1").running {
		t.Fatal("the service that would not stop is reported as stopped")
	}
}

/* A failure before anything moved is a refusal, not a half-changed host. */
func TestStartStackThatFailsOnItsFirstServiceChangesNothing(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)

	for _, found := range host.containers {
		found.running = false
	}

	host.wontStart[deployedRevision+"/db"] = true

	_, err := docker.NewEngine(host).StartStack(context.Background(), plan)

	if errors.Is(err, docker.ErrStackLifecycleIncomplete) {
		t.Fatalf("a start that changed nothing was reported as partial: %v", err)
	}

	if err == nil {
		t.Fatal("a start that failed was reported as a success")
	}

	if host.byName("shop-web-1").running {
		t.Fatal("a service was started after the one it depends on failed")
	}
}

func TestLifecycleRefusesAPlanItDoesNotUnderstand(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)
	plan.PlanVersion = 99

	if _, err := docker.NewEngine(host).StopStack(context.Background(), plan); !errors.Is(
		err,
		docker.ErrStackPlanUnsupported,
	) {
		t.Fatalf("expected an unsupported plan, got %v", err)
	}
}

func TestLifecycleRefusesADependencyItDoesNotCover(t *testing.T) {
	host := newHost()
	plan := deployedStack(host)
	plan.Services[1].DependsOn = []string{"cache"}

	if _, err := docker.NewEngine(host).StopStack(context.Background(), plan); !errors.Is(
		err,
		docker.ErrStackPlanInvalid,
	) {
		t.Fatalf("expected an invalid plan, got %v", err)
	}
}

/** The container name behind a Docker identifier, for reading a result back. */
func containerNameOf(host *fakeHost, dockerID string) string {
	if found, present := host.containers[dockerID]; present {
		return found.name
	}

	return ""
}
