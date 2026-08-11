/**
 * Creates the initial administrator.
 *
 * Dockplane ships with no account and no default password. This command is the
 * only way a privileged user comes into existence, and it refuses to run once
 * an active administrator is present, so it cannot be used to quietly add a
 * second one.
 *
 *   DOCKPLANE_BOOTSTRAP_PASSWORD='…' \
 *     node --import tsx scripts/bootstrap-admin.ts admin@example.internal "Ada Lovelace"
 *
 * The password is read from the environment or prompted for; it is never taken
 * from a command-line argument, where it would land in the shell history and in
 * the process list of every other user on the machine.
 */
import { stdin, stdout } from 'node:process';

import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { resolveSecretFiles } from '../config/configuration';
import { hashPassword } from '../common/crypto';
import { auditEntries, roles, userRoles, users } from '../database/schema';

const ADMINISTRATOR_ROLE = 'Administrator';
const MINIMUM_PASSWORD_LENGTH = 12;

async function readPassword(): Promise<string> {
  const fromEnvironment = resolveSecretFiles(process.env).DOCKPLANE_BOOTSTRAP_PASSWORD;

  if (fromEnvironment) {
    return fromEnvironment;
  }

  if (!stdin.isTTY) {
    throw new Error(
      'Set DOCKPLANE_BOOTSTRAP_PASSWORD, or run this command from a terminal to be prompted.',
    );
  }

  const password = await readHidden('Password for the initial administrator: ');
  const confirmation = await readHidden('Repeat the password: ');

  if (password !== confirmation) {
    throw new Error('The passwords did not match.');
  }

  return password;
}

/**
 * Reads a line from the terminal without echoing it.
 *
 * A password typed into a prompt that echoes is on the screen, in a scrollback
 * buffer, and in whatever recorded the session — which for an installation is
 * often a terminal log somebody keeps. Reading it in raw mode is what makes
 * "it is never echoed" true rather than merely intended.
 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let entered = '';

    const pushBack = (rest: string) => {
      if (rest.length > 0) {
        stdin.unshift(rest);
      }
    };

    const finish = (error?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdout.write('\n');

      if (error) {
        reject(error);
      } else {
        resolve(entered);
      }
    };

    const onData = (chunk: string) => {
      for (const [index, character] of [...chunk].entries()) {
        switch (character) {
          case '\r':
          case '\n':
          case '\u0004':
            // Anything after the newline belongs to whatever asks next, so it
            // goes back on the stream rather than being discarded.
            pushBack(chunk.slice(index + 1));
            finish();
            return;
          // Ctrl-C during a password prompt means stop, not "use this".
          case '\u0003':
            finish(new Error('Cancelled.'));
            return;
          case '\u007f':
          case '\b':
            entered = entered.slice(0, -1);
            break;
          default:
            // Control characters are not part of a password.
            if (character >= ' ') {
              entered += character;
            }
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const displayName = process.argv[3]?.trim() || 'Administrator';
  const url = resolveSecretFiles(process.env).DATABASE_URL;

  if (!url) {
    throw new Error('DATABASE_URL is required');
  }

  if (!email || !email.includes('@')) {
    throw new Error('Usage: bootstrap-admin <email> [display name]');
  }

  const password = await readPassword();

  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`The password must be at least ${MINIMUM_PASSWORD_LENGTH} characters.`);
  }

  const passwordHash = await hashPassword(password);
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  try {
    await db.transaction(async (tx) => {
      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, ADMINISTRATOR_ROLE))
        .limit(1);

      if (!role) {
        throw new Error('Run the migrations before bootstrapping an administrator.');
      }

      /*
       * Serialises concurrent bootstrap attempts.
       *
       * Without the lock two commands could both observe "no administrator"
       * and both create one. The advisory lock is released with the
       * transaction, so a crashed attempt does not block the next.
       */
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dockplane:bootstrap'))`);

      const existing = await tx
        .select({ id: users.id })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(sql`${userRoles.roleId} = ${role.id} and ${users.isActive} = true`)
        .limit(1);

      if (existing.length > 0) {
        throw new Error(
          'An active administrator already exists. Use the recovery procedure documented in ' +
            'docs/operations/recovery.md rather than bootstrapping a second one.',
        );
      }

      const [created] = await tx
        .insert(users)
        .values({ email, passwordHash, displayName })
        .returning({ id: users.id });

      await tx.insert(userRoles).values({ userId: created.id, roleId: role.id });

      await tx.insert(auditEntries).values({
        actorUserId: created.id,
        actorLabel: 'bootstrap-cli',
        action: 'user.bootstrapped',
        targetType: 'user',
        targetId: created.id,
        targetLabel: email,
        result: 'success',
        reasonCode: 'initial_administrator',
      });
    });

    process.stdout.write(
      [
        `Created the initial administrator: ${email}`,
        '',
        'Sign in and enable multi-factor authentication before exposing the control server.',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // The message never contains the password: it is not interpolated anywhere.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
