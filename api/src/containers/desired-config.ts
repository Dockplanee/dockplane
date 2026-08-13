import { SecretBox } from '../common/crypto';
import { AppError } from '../common/errors';
import { containerDesiredConfigs, containerEnvironmentVariables } from '../database/schema';
import { EnvironmentEntry } from './container-spec';

type ConfigRow = typeof containerDesiredConfigs.$inferSelect;
type EnvironmentRow = typeof containerEnvironmentVariables.$inferSelect;

/** The configuration columns, without the identity and state around them. */
export type Configuration = Pick<
  typeof containerDesiredConfigs.$inferInsert,
  | 'image'
  | 'hostname'
  | 'command'
  | 'entrypoint'
  | 'ports'
  | 'mounts'
  | 'networks'
  | 'restartPolicy'
  | 'labels'
  | 'healthcheck'
>;

/** An environment variable as it will be stored: one column or the other. */
export interface StoredVariable {
  readonly key: string;
  readonly value: string | null;
  readonly valueEncrypted: string | null;
  readonly isSecret: boolean;
}

interface RequestedConfiguration {
  readonly image: string;
  readonly hostname?: string;
  readonly command?: string[];
  readonly entrypoint?: string[];
  readonly ports: unknown[];
  readonly mounts: unknown[];
  readonly networks: string[];
  readonly restartPolicy: string;
  readonly labels: Record<string, string>;
  readonly healthcheck?: unknown;
  readonly environment: EnvironmentEntry[];
}

/** Everything but the environment, which is stored separately per variable. */
export function configurationOf(request: RequestedConfiguration): Configuration {
  return {
    image: request.image,
    hostname: request.hostname ?? null,
    command: request.command ?? null,
    entrypoint: request.entrypoint ?? null,
    ports: request.ports,
    mounts: request.mounts,
    networks: request.networks,
    restartPolicy: request.restartPolicy,
    labels: request.labels,
    healthcheck: request.healthcheck ?? null,
  };
}

/**
 * Works out what the new configuration's environment is.
 *
 * The interesting case is `unchanged`, which exists because a browser showing
 * `••••••••` must not be able to send that back as a value. It does not have
 * the secret and never did, so it says which variable it is leaving alone and
 * the server carries the stored envelope across — the same bytes, not a
 * decryption and a re-encryption, so a replacement that changes nothing about a
 * secret does not touch it at all.
 *
 * A `set-secret` is encrypted here, once, for the configuration it belongs to.
 * The plaintext exists inside this call and nowhere else.
 */
export function resolveEnvironment(
  entries: readonly EnvironmentEntry[],
  previous: readonly EnvironmentRow[],
  box: SecretBox,
): StoredVariable[] {
  const carried = new Map(previous.map((row) => [row.key, row]));
  const resolved: StoredVariable[] = [];

  for (const entry of entries) {
    switch (entry.operation) {
      case 'set':
        resolved.push({
          key: entry.key,
          value: entry.value,
          valueEncrypted: null,
          isSecret: false,
        });
        break;

      case 'set-secret':
        resolved.push({
          key: entry.key,
          value: null,
          valueEncrypted: box.encrypt(entry.value),
          isSecret: true,
        });
        break;

      case 'unchanged': {
        const existing = carried.get(entry.key);

        if (!existing) {
          /*
           * Nothing to carry across. Accepting this would mean silently
           * dropping a variable the operator believes they kept, and for a
           * secret that means a container starting without a credential it
           * needs.
           */
          throw new AppError(
            'INVALID_CONTAINER_SPEC',
            `${entry.key} was marked unchanged, but this container has no such variable.`,
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

  return resolved;
}

/**
 * Builds the specification the agent is asked for.
 *
 * The one place a secret becomes plaintext again. It happens per dispatch, in
 * the object that is about to be sent, and the result is not stored, logged or
 * put into an action or an audit entry — the encrypted envelope stays the only
 * durable form.
 */
export function specFor(
  name: string,
  config: ConfigRow,
  environment: readonly EnvironmentRow[],
  box: SecretBox,
) {
  return {
    name,
    image: config.image,
    ...(config.hostname ? { hostname: config.hostname } : {}),
    ...(config.command?.length ? { command: config.command } : {}),
    ...(config.entrypoint?.length ? { entrypoint: config.entrypoint } : {}),
    env: environment.map((variable) => ({
      key: variable.key,
      value: variable.isSecret ? box.decrypt(variable.valueEncrypted!) : (variable.value ?? ''),
    })),
    ports: config.ports,
    mounts: config.mounts,
    networks: config.networks,
    restartPolicy: config.restartPolicy,
    labels: config.labels,
    ...(config.healthcheck ? { healthcheck: config.healthcheck } : {}),
  };
}

/**
 * The environment as an operator may see it.
 *
 * A secret is reported as being one, with no value and no length: a masked
 * string of the right length is a measurement of the secret.
 */
export function presentEnvironment(environment: readonly EnvironmentRow[]) {
  return environment.map((variable) => ({
    key: variable.key,
    secret: variable.isSecret,
    ...(variable.isSecret ? {} : { value: variable.value ?? '' }),
  }));
}
