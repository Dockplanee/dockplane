import { SecretBox } from '../common/crypto';
import { AppError } from '../common/errors';
import { stackRevisionEnvironment } from '../database/schema';

type StoredRow = typeof stackRevisionEnvironment.$inferSelect;

/** An environment variable as a revision stores it: one column or the other. */
export interface StoredVariable {
  readonly key: string;
  readonly value: string | null;
  readonly valueEncrypted: string | null;
  readonly isSecret: boolean;
}

/**
 * What is being done to one variable in a new revision.
 *
 * The same four operations a container's environment uses, and for the same
 * reason: an interface that was never shown a secret cannot send one back, so
 * it says what it is doing instead of supplying a value it does not have.
 */
export type EnvironmentChange =
  | { readonly operation: 'set'; readonly key: string; readonly value: string }
  | { readonly operation: 'set-secret'; readonly key: string; readonly value: string }
  | { readonly operation: 'unchanged'; readonly key: string }
  | { readonly operation: 'remove'; readonly key: string };

/**
 * Builds the environment a new revision will be saved with.
 *
 * A revision's environment is a snapshot, so this produces the whole of it
 * rather than a difference: what is not here is not in the new revision, and
 * what was in the old one stays there untouched.
 *
 * An unchanged secret carries its envelope across byte for byte. It is not
 * decrypted and re-encrypted — there is no reason for the old plaintext to
 * exist again, and a fresh envelope would make two revisions look different
 * where nothing had changed.
 */
export function resolveStackEnvironment(
  changes: readonly EnvironmentChange[],
  previous: readonly StoredRow[],
  box: SecretBox,
): StoredVariable[] {
  const carried = new Map(previous.map((row) => [row.key, row]));
  const resolved: StoredVariable[] = [];

  for (const change of changes) {
    switch (change.operation) {
      case 'set':
        resolved.push({
          key: change.key,
          value: change.value,
          valueEncrypted: null,
          isSecret: false,
        });
        break;

      case 'set-secret':
        resolved.push({
          key: change.key,
          value: null,
          valueEncrypted: box.encrypt(change.value),
          isSecret: true,
        });
        break;

      case 'unchanged': {
        const existing = carried.get(change.key);

        if (!existing) {
          /*
           * Nothing to carry across. Accepting this would drop a variable
           * somebody believes they kept — and for a secret, produce a stack
           * that deploys without a credential it needs.
           */
          throw new AppError(
            'STACK_CONFIGURATION_INVALID',
            `${change.key} was marked unchanged, but the previous revision has no such variable.`,
          );
        }

        resolved.push({
          key: existing.key,
          value: existing.value,
          valueEncrypted: existing.valueEncrypted,
          isSecret: existing.isSecret,
        });

        break;
      }

      case 'remove':
        break;
    }
  }

  const seen = new Set<string>();

  for (const variable of resolved) {
    if (seen.has(variable.key)) {
      throw new AppError('STACK_CONFIGURATION_INVALID', `${variable.key} is given more than once.`);
    }

    seen.add(variable.key);
  }

  return resolved;
}
