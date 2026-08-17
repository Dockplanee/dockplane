import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one contract that spans both languages, checked from one place.
 *
 * The agent projects a container through an allow list before reporting it, and
 * the control server reads labels out of what arrives. Those are two files in
 * two languages, and for one release they disagreed: the server read the three
 * labels that say which stack a container belongs to, the agent forwarded none
 * of them, and a running stack read as never deployed on every host.
 *
 * Neither side's own tests could see it. The agent's said its allow list was
 * exactly what the server reads, which was a claim about a file it cannot see;
 * the server's supplied the labels itself and never asked whether an agent
 * sends them. This reads both files and compares them, which is the smallest
 * thing that would have failed.
 *
 * Deliberately not a shared library or a generator. It parses two declarations
 * by name rather than by position, so moving either one does not break it, and
 * a label added to one side and not the other does.
 */

const REPOSITORY = join(__dirname, '..', '..');

const AGENT_LABEL_SOURCES = [
  'agent/internal/docker/containers.go',
  'agent/internal/docker/spec.go',
  'agent/internal/docker/stack.go',
];

/**
 * What a container has to carry for the control server to attribute it.
 *
 * Written out rather than derived, because this is the thing being protected:
 * the identity a container claims and the stack it claims to be part of. A
 * change here is a change to what Dockplane can know about a host.
 */
const STACK_ATTRIBUTION_LABELS = [
  'io.dockplane.managed',
  'io.dockplane.container-id',
  'io.dockplane.stack-id',
  'io.dockplane.stack-service',
  'io.dockplane.stack-revision-id',
];

const read = (path: string): string => readFileSync(join(REPOSITORY, path), 'utf8');

/** Every `LabelX = "..."` the agent declares, by constant name. */
function agentLabelConstants(): Map<string, string> {
  const declared = new Map<string, string>();

  for (const source of AGENT_LABEL_SOURCES) {
    for (const match of read(source).matchAll(/\b(Label[A-Za-z]*)\s*=\s*"([^"]+)"/g)) {
      declared.set(match[1], match[2]);
    }
  }

  return declared;
}

/** The label values inside the agent's `forwardedLabels` map. */
function agentForwardedLabels(): Set<string> {
  const source = read('agent/internal/docker/containers.go');
  const block = /var forwardedLabels = map\[string\]bool\{([\s\S]*?)\n\}/.exec(source);

  if (!block) {
    throw new Error('forwardedLabels is no longer a map literal in containers.go');
  }

  const body = block[1].replace(/\/\/[^\n]*/g, '');
  const declared = agentLabelConstants();
  const forwarded = new Set<string>();

  for (const entry of body.matchAll(/^\s*([A-Za-z"][^:]*):\s*true\s*,/gm)) {
    const key = entry[1].trim();
    const value = key.startsWith('"') ? key.slice(1, -1) : declared.get(key);

    if (!value) {
      throw new Error(`forwardedLabels names ${key}, which is not a label this agent declares`);
    }

    forwarded.add(value);
  }

  return forwarded;
}

/** The `io.dockplane.*` labels the control server's discovery reads. */
function serverReadLabels(): Set<string> {
  const source = read('api/src/discovery/discovery.service.ts');
  const read_ = new Set<string>();

  for (const match of source.matchAll(/const\s+DOCKPLANE_[A-Z_]+\s*=\s*'([^']+)'/g)) {
    read_.add(match[1]);
  }

  return read_;
}

describe('the labels an agent forwards and the labels the control server reads', () => {
  const forwarded = agentForwardedLabels();

  it('carries everything stack attribution depends on', () => {
    const missing = STACK_ATTRIBUTION_LABELS.filter((label) => !forwarded.has(label));

    expect(missing).toEqual([]);
  });

  /*
   * The general form of the same failure. A label the server begins to read is
   * one an agent has to be told to send, and adding it on one side only is how
   * this went wrong the first time.
   */
  it('carries every Dockplane label the server reads', () => {
    const unreachable = [...serverReadLabels()].filter((label) => !forwarded.has(label));

    expect(unreachable).toEqual([]);
  });

  /*
   * The allow list is a boundary, not a convenience. Labels are writable by
   * anyone who can reach the daemon, so the agent forwards what the product
   * groups by and nothing else — an operator's own labels stay on the host.
   */
  it('is an allow list of named labels, not a pattern', () => {
    const source = readFileSync(
      join(REPOSITORY, 'agent/internal/docker/containers.go'),
      'utf8',
    );
    const block = /var forwardedLabels = map\[string\]bool\{([\s\S]*?)\n\}/.exec(source)![1];

    expect(block).not.toMatch(/\*/);
    expect(block).not.toMatch(/HasPrefix|Contains|MatchString/);

    for (const label of forwarded) {
      expect(label).toMatch(/^(io\.dockplane|com\.docker\.compose)\./);
    }
  });

  it('forwards nothing an operator wrote', () => {
    expect(forwarded.has('internal.deploy.token')).toBe(false);
    expect(forwarded.has('maintainer')).toBe(false);
    expect(forwarded.has('io.dockplane.anything')).toBe(false);
  });
});
