import { describe, expect, it } from 'vitest';

import { StackConfiguration } from '../../data/dockplane-api';
import { diffEnvironment, diffLines, diffRevisions } from './revision-diff';

/**
 * What changes between two revisions, and what may not be inferred.
 *
 * The secret cases are the ones worth being strict about. The browser is never
 * shown a stored secret, so it cannot tell whether two revisions' values differ
 * — and an interface that claimed to know would either be guessing or have been
 * shown something it should not have been.
 */
describe('comparing Compose files', () => {
  it('reports what was added and what was removed', () => {
    const lines = diffLines('a\nb\nc\n', 'a\nx\nc\n');

    expect(lines.filter((line) => line.kind === 'removed').map((line) => line.text)).toEqual(['b']);
    expect(lines.filter((line) => line.kind === 'added').map((line) => line.text)).toEqual(['x']);
  });

  it('says nothing changed when nothing changed', () => {
    expect(diffLines('a\nb\n', 'a\nb\n').every((line) => line.kind === 'context')).toBe(true);
  });

  it('keeps the surrounding lines as context', () => {
    const lines = diffLines('one\ntwo\nthree\n', 'one\ntwo\nfour\n');

    expect(lines.filter((line) => line.kind === 'context').map((line) => line.text)).toEqual([
      'one',
      'two',
      '',
    ]);
  });
});

describe('comparing environments', () => {
  const variable = (key: string, value?: string, secret = false) =>
    secret ? { key, secret: true } : { key, secret: false, value: value ?? '' };

  it('reports an ordinary value that changed, with both values', () => {
    const entries = diffEnvironment([variable('APP_ENV', 'staging')], [variable('APP_ENV', 'production')]);

    expect(entries).toEqual([
      { key: 'APP_ENV', kind: 'changed', from: 'staging', to: 'production' },
    ]);
  });

  it('reports one that was added and one that was removed', () => {
    const entries = diffEnvironment([variable('OLD', '1')], [variable('NEW', '2')]);

    expect(entries.map((entry) => entry.kind).sort()).toEqual(['added', 'removed']);
  });

  /*
   * The case the whole design turns on. Both revisions have a secret of that
   * name; whether the value behind them differs is not something this side can
   * see, and finding out would mean being shown both.
   */
  it('does not claim to know whether two secrets differ', () => {
    const entries = diffEnvironment(
      [variable('DB_PASSWORD', undefined, true)],
      [variable('DB_PASSWORD', undefined, true)],
    );

    expect(entries).toEqual([{ key: 'DB_PASSWORD', kind: 'secret_unknown' }]);
  });

  it('carries no value for a secret that was added or removed', () => {
    const entries = diffEnvironment(
      [variable('GONE', undefined, true)],
      [variable('FRESH', undefined, true)],
    );

    for (const entry of entries) {
      expect(entry.from).toBeUndefined();
      expect(entry.to).toBeUndefined();
    }

    expect(entries.map((entry) => entry.kind).sort()).toEqual(['secret_added', 'secret_removed']);
  });

  it('treats a value that became a secret as something it cannot compare', () => {
    const entries = diffEnvironment(
      [variable('TOKEN', 'in-the-open')],
      [variable('TOKEN', undefined, true)],
    );

    expect(entries).toEqual([{ key: 'TOKEN', kind: 'secret_unknown' }]);
  });
});

describe('comparing revisions', () => {
  const configuration = (compose: string, environment: StackConfiguration['environment']) =>
    ({ revisionId: 'r', revisionNumber: 1, compose, environment }) as StackConfiguration;

  it('reports two identical revisions as identical', () => {
    const diff = diffRevisions(
      configuration('services:\n  web:\n', [{ key: 'A', secret: false, value: '1' }]),
      configuration('services:\n  web:\n', [{ key: 'A', secret: false, value: '1' }]),
    );

    expect(diff.identical).toBe(true);
  });

  it('is not identical when only the environment differs', () => {
    const diff = diffRevisions(
      configuration('same\n', [{ key: 'A', secret: false, value: '1' }]),
      configuration('same\n', [{ key: 'A', secret: false, value: '2' }]),
    );

    expect(diff.identical).toBe(false);
  });
});
