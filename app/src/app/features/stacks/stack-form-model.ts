import { EnvironmentChange, EnvironmentVariable } from '../../data/dockplane-api';

/**
 * What a stack form holds, and how it becomes a request.
 *
 * Deliberately not the API shape, for the same reason a container's form is
 * not: the interface has to keep things the API has no field for — whether a
 * stored secret is being left alone — and the API has to receive something the
 * form never holds, which is a secret it was never shown.
 *
 * Pure functions over plain data, so what a form would send can be checked
 * without a browser.
 */

export interface StackEnvironmentRow {
  key: string;
  value: string;
  secret: boolean;
  /** True for a variable that already exists on the server. */
  stored: boolean;
  action: 'unchanged' | 'change' | 'remove';
}

export interface StackFormModel {
  name: string;
  hostId: string;
  compose: string;
  environment: StackEnvironmentRow[];
}

export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/** Compose's own project-name rule, which a stack name is. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyStackForm(): StackFormModel {
  return { name: '', hostId: '', compose: STARTER_COMPOSE, environment: [] };
}

/**
 * What a new stack starts with.
 *
 * Enough shape to be edited rather than typed from nothing, and deliberately
 * not a working example somebody might deploy without reading.
 */
const STARTER_COMPOSE = ['services:', '  web:', '    image: nginx:1.27', ''].join('\n');

/** The form for editing an existing revision. */
export function formFromConfiguration(input: {
  name: string;
  hostId: string;
  compose: string;
  environment: readonly EnvironmentVariable[];
}): StackFormModel {
  return {
    name: input.name,
    hostId: input.hostId,
    compose: input.compose,
    environment: input.environment.map((variable) => ({
      key: variable.key,
      // A stored secret has no value here and never acquires one.
      value: variable.secret ? '' : (variable.value ?? ''),
      secret: variable.secret,
      stored: true,
      action: 'unchanged' as const,
    })),
  };
}

/**
 * The environment as the API receives it.
 *
 * The one place the secret rule lives. A stored secret nobody touched is sent
 * as `unchanged` and carries no value — the interface was never shown one, and
 * inventing a masked string to send back would be sending the mask as the
 * secret.
 */
export function environmentChanges(rows: readonly StackEnvironmentRow[]): EnvironmentChange[] {
  const changes: EnvironmentChange[] = [];

  for (const row of rows) {
    const key = row.key.trim();

    if (!key) {
      continue;
    }

    if (row.stored && row.action === 'remove') {
      changes.push({ operation: 'remove', key });
      continue;
    }

    if (row.stored && row.secret && row.action === 'unchanged') {
      changes.push({ operation: 'unchanged', key });
      continue;
    }

    changes.push(
      row.secret
        ? { operation: 'set-secret', key, value: row.value }
        : { operation: 'set', key, value: row.value },
    );
  }

  return changes;
}

/** The values the compiler needs to resolve a file, for a validation request. */
export function validationEnvironment(
  rows: readonly StackEnvironmentRow[],
): { key: string; value: string; secret: boolean }[] {
  return rows
    .filter((row) => row.key.trim() && !(row.stored && row.action === 'remove'))
    .map((row) => ({ key: row.key.trim(), value: row.value, secret: row.secret }));
}

/**
 * What is wrong with the form, in the order somebody reading it would find it.
 *
 * The server checks all of this again. This exists so an operator is told while
 * they are typing rather than after a round trip, and it never decides that
 * something is acceptable — only that it is not yet worth sending.
 */
export function problemsIn(
  model: StackFormModel,
  options: { requireIdentity: boolean },
): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (options.requireIdentity) {
    if (!model.name.trim()) {
      problems.push({ field: 'name', message: 'A stack needs a name.' });
    } else if (!NAME_PATTERN.test(model.name.trim())) {
      problems.push({
        field: 'name',
        message: 'Use lower-case letters, digits, hyphens and underscores.',
      });
    }

    if (!model.hostId) {
      problems.push({ field: 'hostId', message: 'Choose the host this stack runs on.' });
    }
  }

  if (!model.compose.trim()) {
    problems.push({ field: 'compose', message: 'A stack needs a Compose file.' });
  }

  const seen = new Set<string>();

  model.environment.forEach((row, index) => {
    const key = row.key.trim();

    if (!key) {
      problems.push({ field: `environment.${index}.key`, message: 'A variable needs a name.' });
      return;
    }

    if (!KEY_PATTERN.test(key)) {
      problems.push({
        field: `environment.${index}.key`,
        message: 'Use letters, digits and underscores, starting with a letter or underscore.',
      });
    }

    if (seen.has(key)) {
      problems.push({
        field: `environment.${index}.key`,
        message: 'This variable is listed twice.',
      });
    }

    seen.add(key);

    // A new secret with no value would be stored as an empty credential.
    if (row.secret && !row.stored && !row.value) {
      problems.push({ field: `environment.${index}.value`, message: 'A secret needs a value.' });
    }

    if (row.stored && row.secret && row.action === 'change' && !row.value) {
      problems.push({
        field: `environment.${index}.value`,
        message: 'Enter the new secret value.',
      });
    }
  });

  return problems;
}

export function problemFor(problems: readonly FieldProblem[], field: string): string | undefined {
  return problems.find((problem) => problem.field === field)?.message;
}
