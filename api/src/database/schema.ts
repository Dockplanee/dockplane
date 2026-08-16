import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Control-plane schema.
 *
 * Public identifiers are UUIDs so they cannot be enumerated. Every timestamp is
 * stored with time zone and written in UTC. Secrets are never stored in a
 * recoverable form unless the product genuinely needs to read them back: session
 * and enrollment tokens and recovery codes are kept as digests, the MFA secret
 * is kept encrypted because TOTP verification requires the original value.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** AES-256-GCM envelope; null until MFA setup is confirmed. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaConfirmedAt: timestamp('mfa_confirmed_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('users_email_unique').on(sql`lower(${table.email})`)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('recovery_codes_user_idx').on(table.userId),
    uniqueIndex('recovery_codes_hash_unique').on(table.codeHash),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque token; the raw token exists only in the cookie. */
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    /**
     * A session that has authenticated the password but not yet the second
     * factor can do nothing except complete or abandon the MFA challenge.
     */
    mfaPending: boolean('mfa_pending').notNull().default(false),
    userAgent: text('user_agent'),
    sourceIp: text('source_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Built-in roles are seeded by migration and cannot be deleted. */
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('roles_name_unique').on(table.name)],
);

export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    description: text('description').notNull().default(''),
  },
  (table) => [uniqueIndex('permissions_key_unique').on(table.key)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

export const agentEnrollmentTokens = pgTable(
  'agent_enrollment_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of 256 bits of random material; the raw token is shown once. */
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Operator hint about the host this token is meant for. Not trusted. */
    intendedHostname: text('intended_hostname'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedByAgentId: uuid('consumed_by_agent_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [uniqueIndex('enrollment_tokens_hash_unique').on(table.tokenHash)],
);

/**
 * A host somebody is in the middle of adding.
 *
 * Deliberately not a host row. A host that has never been reached is not
 * inventory, and creating one before an agent exists leaves an entry nobody can
 * distinguish from a machine that has gone quiet. The real host and agent are
 * created by enrollment, exactly as they always were, and referenced here
 * afterwards.
 *
 * The bootstrap ticket is the operator's half of the exchange: it authorises
 * one machine to ask for one enrollment token. Only its digest is stored, it is
 * spent atomically, and it is not the credential the agent ends up holding.
 */
export const hostSetups = pgTable(
  'host_setups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Operator's own name for the machine. Never an identity. */
    displayName: text('display_name'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** SHA-256 of 256 bits of random material. The raw ticket is shown once. */
    ticketHash: text('ticket_hash').notNull(),
    ticketExpiresAt: timestamp('ticket_expires_at', { withTimezone: true }).notNull(),
    ticketConsumedAt: timestamp('ticket_consumed_at', { withTimezone: true }),
    /** Bumped by a regenerate, so an old ticket cannot be told apart by age. */
    ticketIssuedAt: timestamp('ticket_issued_at', { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    /** The enrollment token minted when the ticket was spent. */
    enrollmentTokenId: uuid('enrollment_token_id'),
    agentId: uuid('agent_id'),
    hostId: uuid('host_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('host_setups_ticket_hash_unique').on(table.ticketHash),
    index('host_setups_created_idx').on(table.createdAt),
  ],
);

export const hosts = pgTable(
  'hosts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostname: text('hostname').notNull(),
    displayName: text('display_name'),
    os: text('os'),
    architecture: text('architecture'),
    kernel: text('kernel'),
    dockerVersion: text('docker_version'),
    agentVersion: text('agent_version'),
    /** Latest metric snapshot; history is out of scope for this milestone. */
    metrics: jsonb('metrics'),
    metadata: jsonb('metadata'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    /**
     * When this host was taken out of the active working set.
     *
     * Null is active, and a timestamp is archived: the state and the moment it
     * was reached are the same field, which is what makes it auditable and
     * reversible without a state machine. Nothing is deleted by it — every
     * container, project, stack, action and audit entry goes on pointing at
     * this host, and every historical view goes on resolving its identity.
     *
     * Deliberately not derived from anything. A host that is offline, whose
     * agent was revoked, or that shares a hostname with five others is not
     * archived until somebody says so, because those are observations and this
     * is a decision.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('hosts_hostname_idx').on(table.hostname),
    /* Every working list reads the active hosts, which is most of them. */
    index('hosts_archived_idx').on(table.archivedAt),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    /** Identity of record. The gateway trusts this, never a payload field. */
    certificateFingerprint: text('certificate_fingerprint').notNull(),
    certificateSerial: text('certificate_serial').notNull(),
    certificateNotAfter: timestamp('certificate_not_after', { withTimezone: true }).notNull(),
    version: text('version'),
    protocolVersion: integer('protocol_version').notNull().default(1),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['pending', 'connected', 'disconnected', 'revoked'] })
      .notNull()
      .default('pending'),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: text('revocation_reason'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agents_fingerprint_unique').on(table.certificateFingerprint),
    index('agents_host_idx').on(table.hostId),
  ],
);

export const containers = pgTable(
  'containers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    /**
     * Docker IDs are only unique per host, so identity is host-scoped.
     *
     * Absent while a create has not produced a container yet: the resource is
     * written before the agent is asked for anything, so that a control server
     * which dies mid-create can find out afterwards what happened.
     */
    dockerId: text('docker_id'),
    name: text('name').notNull(),
    image: text('image').notNull(),
    imageId: text('image_id'),
    state: text('state').notNull(),
    health: text('health').notNull().default('none'),
    restartCount: integer('restart_count').notNull().default(0),
    composeProjectId: uuid('compose_project_id'),
    /**
     * The stack this container belongs to, and which of its services it is.
     *
     * Read from the labels Dockplane set when it created the container, never
     * from a name that happened to match. Nulled rather than deleted when a
     * stack goes, because the container may still be running on the host.
     */
    stackId: uuid('stack_id'),
    stackService: text('stack_service'),
    /**
     * The revision this container says it is running.
     *
     * Read from the label the agent stamped on it, and the only thing that can
     * answer it: two revisions of a service may differ in nothing observable —
     * a changed secret leaves no trace in anything this projection carries.
     */
    stackRevisionId: text('stack_revision_id'),
    dockerCreatedAt: timestamp('docker_created_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Summary-level extras from discovery: the Compose service and status. */
    metadata: jsonb('metadata'),
    /**
     * The sanitised inspect projection.
     *
     * Built field by field from what the agent reported, never the raw Docker
     * inspect payload. Environment values, credentials and host paths have no
     * column to land in.
     */
    detail: jsonb('detail'),
    /** When the detail was last read from the host, separate from the summary. */
    detailObservedAt: timestamp('detail_observed_at', { withTimezone: true }),
    /**
     * Set when two running containers claim the same Dockplane identity and no
     * replacement explains it.
     *
     * Guessing which one is the real container would mean guessing by name, by
     * age or by state, and being wrong would remove somebody's workload. So
     * nothing is guessed: the resource says it needs attention and refuses
     * further mutation until a person resolves it.
     */
    identityConflict: jsonb('identity_conflict').$type<{
      readonly dockerIds: readonly string[];
      readonly observedAt: string;
    } | null>(),
    /**
     * The configuration the running container says it is.
     *
     * Read back off the container rather than assumed from what was asked for,
     * and the only thing that can settle an interrupted replacement: the two
     * configurations may differ in nothing observable, since a replacement can
     * change a secret alone and this projection holds no environment values.
     *
     * Null for a container Dockplane did not build. Also null for one that
     * claims to be managed but carries no readable identity, which is a state
     * recovery refuses to interpret rather than a state it resolves.
     */
    observedDesiredConfigId: text('observed_desired_config_id'),
    /**
     * The last complete discovery that saw this container.
     *
     * Reconciliation removes rows only when a snapshot finished, so a sync that
     * failed halfway cannot make surviving containers look deleted.
     */
    snapshotId: uuid('snapshot_id'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('containers_host_docker_id_unique').on(table.hostId, table.dockerId),
    /*
     * One unfinished create per name per host.
     *
     * The in-memory lock cannot answer this after a restart, when it is empty
     * and the unfinished create is still entirely real. Compared without case,
     * matching the lock the running process takes.
     */
    uniqueIndex('containers_host_pending_name_unique')
      .on(table.hostId, sql`lower(${table.name})`)
      .where(sql`docker_id IS NULL`),
    /*
     * One container per service of a stack.
     *
     * A service is one container in this product, and the resource behind it
     * stays the same across replacements. Two rows claiming one service would
     * leave nothing able to say which container a service is.
     */
    uniqueIndex('containers_stack_service_unique')
      .on(table.stackId, table.stackService)
      .where(sql`stack_id IS NOT NULL AND stack_service IS NOT NULL`),
    index('containers_stack_idx').on(table.stackId),
  ],
);

export const composeProjects = pgTable(
  'compose_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    projectName: text('project_name').notNull(),
    /** Reported by the Compose working-directory label when present. */
    workingDir: text('working_dir'),
    configFiles: text('config_files'),
    status: text('status').notNull().default('unknown'),
    serviceCount: integer('service_count').notNull().default(0),
    runningCount: integer('running_count').notNull().default(0),
    services: jsonb('services').$type<unknown[]>(),
    /** When the services were last read from the host, separate from the summary. */
    detailObservedAt: timestamp('detail_observed_at', { withTimezone: true }),
    snapshotId: uuid('snapshot_id'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('compose_host_project_unique').on(table.hostId, table.projectName)],
);

/**
 * Durable action model.
 *
 * Established now so the audit and correlation story is complete, but this
 * milestone dispatches no remote mutations: rows are only written for
 * server-side operations such as enrollment and revocation.
 */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorKind: text('actor_kind', { enum: ['user', 'system'] })
      .notNull()
      .default('user'),
    capability: text('capability').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    hostId: uuid('host_id').references(() => hosts.id, { onDelete: 'set null' }),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: text('error_code'),
    correlationId: text('correlation_id').notNull(),
  },
  (table) => [index('actions_requested_idx').on(table.requestedAt)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id').references(() => hosts.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: text('severity', { enum: ['info', 'warning', 'critical'] })
      .notNull()
      .default('info'),
    resource: text('resource').notNull(),
    message: text('message').notNull(),
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('events_occurred_idx').on(table.occurredAt)],
);

/** Append-oriented security trail. Rows are written, never updated. */
export const auditEntries = pgTable(
  'audit_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    result: text('result', { enum: ['success', 'failure'] }).notNull(),
    reasonCode: text('reason_code'),
    sourceIp: text('source_ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_occurred_idx').on(table.occurredAt),
    /*
     * The audit view is read newest-first and is usually filtered to one kind
     * of action. Without the action in front, that filter is a scan of the
     * whole trail, which is the one table that only ever grows.
     */
    index('audit_action_occurred_idx').on(table.action, table.occurredAt.desc()),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  roles: many(userRoles),
  recoveryCodes: many(recoveryCodes),
}));

/**
 * A stack Dockplane is the source of truth for.
 *
 * Distinct from `compose_projects`, which is what discovery found on a host and
 * stays read-only. A project becomes a stack only by being adopted, deliberately
 * and by somebody, and adoption is what makes Dockplane responsible for
 * deploying it. Nothing here is created by discovery.
 */
export const stacks = pgTable(
  'stacks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    /** The Compose project name on the host. Unique per host, as Compose is. */
    name: text('name').notNull(),
    /**
     * Where this stack came from.
     *
     * `dockplane` was written here; `adopted` existed on the host first. The
     * difference matters when reporting what Dockplane can and cannot know
     * about the configuration a stack is running.
     */
    sourceType: text('source_type').notNull().default('dockplane'),
    /** Observed, never asserted from the outcome of an API call. */
    status: text('status').notNull().default('unknown'),
    /** The newest revision anybody saved. Saved is not deployed. */
    latestRevisionId: uuid('latest_revision_id'),
    /** The revision last successfully deployed, as opposed to last saved. */
    currentRevisionId: uuid('current_revision_id'),
    /** The revision a deployment is working towards, while one is running. */
    desiredRevisionId: uuid('desired_revision_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastDeployedAt: timestamp('last_deployed_at', { withTimezone: true }),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }),
    /** The discovered project this stack manages, once it is deployed. */
    composeProjectId: uuid('compose_project_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('stacks_host_name_unique').on(table.hostId, table.name),
    index('stacks_host_idx').on(table.hostId),
  ],
);

/**
 * An immutable configuration of a stack.
 *
 * A revision is written once and never updated. A deployment names one, so what
 * ran is always a thing that can be looked at afterwards rather than whatever
 * happened to be in an editor at the time.
 *
 * The Compose source is encrypted at rest with the application encryption key,
 * because a Compose file can carry credentials inline and Dockplane cannot tell
 * when it does. The environment is snapshotted with it, so rolling back to a
 * revision restores the configuration that revision actually meant.
 */
export const stackRevisions = pgTable(
  'stack_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stackId: uuid('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    /** Monotonic per stack, and what an operator sees: "revision 12". */
    number: integer('number').notNull(),
    /** AES-256-GCM envelope. Never stored or returned as plain text. */
    composeSourceEncrypted: text('compose_source_encrypted').notNull(),
    /**
     * The environment as it stood when this revision was written.
     *
     * Secret values inside are encrypted individually, exactly as they are in
     * the live environment. A revision's secrets are never revealed: reveal
     * answers for the current value of a variable, not for what it used to be.
     */
    /**
     * Superseded by `stackRevisionEnvironment`, and kept because it is part of
     * a released schema. Nothing reads it.
     */
    environmentSnapshot: jsonb('environment_snapshot').$type<unknown[]>(),
    /** What changed, in words, without naming a value. */
    changeSummary: text('change_summary'),
    /**
     * The contract this revision was checked against.
     *
     * A revision is compiled before it is stored, so it is worth being able to
     * say afterwards which agreement it passed — versions of the protocol and
     * the plan rather than a product version, because the shape is what matters.
     */
    compilerProtocolVersion: integer('compiler_protocol_version'),
    planVersion: integer('plan_version'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    /**
     * What it would create, and nothing it would create it with.
     *
     * Service, network and volume names, so a listing can describe a stack
     * without decrypting its source.
     */
    summary: jsonb('summary').$type<{
      readonly services: readonly string[];
      readonly networks: readonly string[];
      readonly volumes: readonly string[];
      /**
       * Which services wait for which, by name.
       *
       * Part of the revision rather than something to work out later: starting
       * and stopping a deployed stack has to follow the dependencies, and it
       * deliberately does not compile the Compose source to find them — that
       * would put a compiler and a decryption key in the path of stopping a
       * stack during an incident.
       */
      readonly dependsOn?: Readonly<Record<string, readonly string[]>>;
    } | null>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('stack_revisions_stack_number_unique').on(table.stackId, table.number),
    index('stack_revisions_stack_idx').on(table.stackId),
  ],
);

/**
 * The environment a revision was saved with.
 *
 * Per revision, not per stack, because a revision is what a rollback goes back
 * to and an environment that could be edited afterwards would change what an
 * old revision meant. Structured rather than a `.env` blob for the same reason
 * a container's is: a blob cannot say which value is a secret, and without that
 * nothing could be redacted.
 */
export const stackRevisionEnvironment = pgTable(
  'stack_revision_environment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => stackRevisions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Set only when the variable is not a secret. */
    value: text('value'),
    /** AES-256-GCM envelope. Set only when the variable is a secret. */
    valueEncrypted: text('value_encrypted'),
    isSecret: boolean('is_secret').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('stack_revision_environment_key_unique').on(table.revisionId, table.key),
    index('stack_revision_environment_revision_idx').on(table.revisionId),
  ],
);

/**
 * One attempt to put a stack on a host.
 *
 * Written before an agent is asked for anything, for the same reason a
 * container resource is: a control server that dies mid-deployment leaves
 * containers on a host, and without a record of the attempt nothing afterwards
 * could say they were meant to be there.
 *
 * An attempt is resolved or it is not. `succeeded` and `failed` are answers;
 * `interrupted` and `needs_attention` are the states where the server does not
 * know, or knows that a person has to look — and the database allows only one
 * unresolved attempt per stack, which is the part a restart cannot forget.
 */
export const stackDeployments = pgTable(
  'stack_deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stackId: uuid('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    /** The revision this attempt was applying, not the stack's newest. */
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => stackRevisions.id, { onDelete: 'cascade' }),
    /**
     * What the stack was confirmed to be running when this was requested.
     *
     * The last established state, not what the host happened to look like: a
     * stack that needs attention has a host that disagrees with itself, and an
     * attempt has to be judged against something that was actually known.
     *
     * Null for the first deployment of a stack.
     */
    fromRevisionId: uuid('from_revision_id').references(() => stackRevisions.id, {
      onDelete: 'set null',
    }),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    /**
     * Why this attempt was made: `initial`, `redeploy`, `rollback` or `repair`.
     *
     * All four do the same thing — apply a revision — and the word is what an
     * operator reads in the history afterwards.
     */
    kind: text('kind').notNull().default('initial'),
    status: text('status').notNull().default('pending'),
    actionId: uuid('action_id'),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * What happened to each service.
     *
     * Names, states and codes. Never anything from the plan: a plan carries
     * resolved environment values, and this row is read by an interface.
     */
    detail: jsonb('detail').$type<{
      readonly services: readonly {
        readonly serviceName: string;
        readonly containerId: string;
        readonly state?: string;
        readonly errorCode?: string;
      }[];
    } | null>(),
    failureCode: text('failure_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('stack_deployments_stack_idx').on(table.stackId),
    index('stack_deployments_host_idx').on(table.hostId),
    /*
     * One unfinished attempt per stack.
     *
     * The in-memory lock covers one running process; this covers a restart,
     * where the lock is empty and the half-applied containers are still there.
     *
     * Needing attention is not unfinished. It is an answer, and the way out of
     * it is to apply a revision deliberately — which is another attempt.
     */
    uniqueIndex('stack_deployments_unresolved_unique')
      .on(table.stackId)
      .where(sql`status IN ('pending', 'running', 'interrupted')`),
  ],
);

/**
 * Starting, stopping or restarting a stack that is already deployed.
 *
 * Separate from a deployment because it is a different thing: no revision is
 * applied, no container is created or recreated, and neither the newest saved
 * revision nor the deployed one changes. Recording it as a deployment would make
 * the history say a revision was applied when none was.
 *
 * What it shares with a deployment is why the row exists at all. An operation
 * whose answer never came back leaves a host in a state nobody has established,
 * and the record of it is what keeps the stack blocked across a restart of the
 * control server — the moment the in-memory lock is gone.
 */
export const stackOperations = pgTable(
  'stack_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stackId: uuid('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    /**
     * The revision that was deployed when this was requested.
     *
     * An operation is for the containers of one revision. If the host turns out
     * to be running another, the two sides disagree about what is deployed and
     * no lifecycle operation may proceed on that basis.
     */
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => stackRevisions.id, { onDelete: 'cascade' }),
    hostId: uuid('host_id')
      .notNull()
      .references(() => hosts.id, { onDelete: 'cascade' }),
    /** `start`, `stop` or `restart`. */
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    actionId: uuid('action_id'),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * What each service looked like immediately before the operation.
     *
     * The only way to tell afterwards whether a restart happened. A restart
     * keeps the container, its image, its configuration and its identifier;
     * everything an observer could compare is the same before and after except
     * when Docker last started it.
     *
     * Identifiers and a timestamp. Nothing from a configuration, and nothing
     * that could carry a value out of an environment.
     */
    fingerprint: jsonb('fingerprint').$type<{
      readonly services: readonly {
        readonly serviceName: string;
        readonly containerId: string;
        readonly dockerId: string;
        readonly startedAt: string | null;
      }[];
    } | null>(),
    /** What happened to each service. Names, states and codes. */
    detail: jsonb('detail').$type<{
      readonly services: readonly {
        readonly serviceName: string;
        readonly containerId: string;
        readonly state?: string;
      }[];
    } | null>(),
    failureCode: text('failure_code'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('stack_operations_stack_idx').on(table.stackId),
    index('stack_operations_host_idx').on(table.hostId),
    /*
     * One unfinished operation per stack, for the same reason a deployment has
     * one: the in-memory lock covers a running process, and this covers the
     * restart that clears it.
     *
     * A deployment and an operation block each other too. That is not something
     * an index across two tables can say, so the guard every mutation goes
     * through reads both.
     */
    uniqueIndex('stack_operations_unresolved_unique')
      .on(table.stackId)
      .where(sql`status IN ('pending', 'running', 'interrupted')`),
  ],
);

/**
 * A stack's environment, as variables rather than as a file.
 *
 * Structured because a `.env` blob cannot say which value is a secret, and
 * without that Dockplane could not redact one. A non-secret value is stored as
 * it is; a secret is encrypted and has no column that could hold it in the
 * clear.
 */
export const stackEnvironmentVariables = pgTable(
  'stack_environment_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stackId: uuid('stack_id')
      .notNull()
      .references(() => stacks.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Set only when the variable is not a secret. */
    value: text('value'),
    /** AES-256-GCM envelope. Set only when the variable is a secret. */
    valueEncrypted: text('value_encrypted'),
    isSecret: boolean('is_secret').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('stack_environment_stack_key_unique').on(table.stackId, table.key),
    index('stack_environment_stack_idx').on(table.stackId),
  ],
);

/**
 * What a Dockplane-managed container is supposed to be.
 *
 * Discovery records what a container *is*; this records what it was asked to
 * be. The two are deliberately separate: an inspect is an observation of a host
 * and cannot be the place a configuration lives, because a host can be changed
 * by something that is not Dockplane.
 *
 * A row here is also what makes a container managed. A container found by
 * discovery has none, stays observed-only, and is not editable — Dockplane has
 * never been told what it is supposed to be, and inventing an answer from an
 * inspect would be claiming an intent nobody expressed.
 *
 * No environment values live here. They are variables, in a table of their own,
 * so that a secret has exactly one home and it is an encrypted one.
 */
export const containerDesiredConfigs = pgTable(
  'container_desired_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    containerId: uuid('container_id')
      .notNull()
      .references(() => containers.id, { onDelete: 'cascade' }),
    /*
     * Whether this is what the container is, or what it is being asked to
     * become.
     *
     * A replacement is a Docker side effect, and a database transaction cannot
     * roll one back. So the intended configuration is written before the agent
     * is asked to do anything, and becomes current only once the container
     * running it has been observed — which means a control server that dies
     * halfway through finds both on restart and can tell which one happened.
     */
    state: text('state').notNull().default('pending'),
    /** The mutation that owns this candidate, for recovery and correlation. */
    actionId: uuid('action_id'),
    image: text('image').notNull(),
    hostname: text('hostname'),
    command: jsonb('command').$type<string[]>(),
    entrypoint: jsonb('entrypoint').$type<string[]>(),
    ports: jsonb('ports').$type<unknown[]>().notNull().default([]),
    mounts: jsonb('mounts').$type<unknown[]>().notNull().default([]),
    networks: jsonb('networks').$type<string[]>().notNull().default([]),
    restartPolicy: text('restart_policy').notNull().default('no'),
    labels: jsonb('labels').$type<Record<string, string>>().notNull().default({}),
    healthcheck: jsonb('healthcheck').$type<unknown>(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    /*
     * One of each per container, enforced here rather than in whichever code
     * path happens to write the row. Two currents would mean nobody could say
     * what a container is supposed to be.
     */
    uniqueIndex('container_desired_current_unique')
      .on(table.containerId)
      .where(sql`state = 'current'`),
    uniqueIndex('container_desired_pending_unique')
      .on(table.containerId)
      .where(sql`state = 'pending'`),
    index('container_desired_container_idx').on(table.containerId),
  ],
);

/**
 * A managed container's environment, as variables rather than as a blob.
 *
 * The same shape and the same database constraint as a stack's, because a
 * secret is a secret wherever it is configured: a secret row carries an
 * envelope and no plain value, and an ordinary row carries no envelope.
 */
export const containerEnvironmentVariables = pgTable(
  'container_environment_variables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /*
     * The configuration these variables belong to, not the container.
     *
     * While a replacement is pending a container has two configurations, and a
     * variable that hung off the container could not say which one it was part
     * of — which for a secret means not being able to say which value is
     * actually running.
     */
    desiredConfigId: uuid('desired_config_id')
      .notNull()
      .references(() => containerDesiredConfigs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value'),
    valueEncrypted: text('value_encrypted'),
    isSecret: boolean('is_secret').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('container_environment_config_key_unique').on(table.desiredConfigId, table.key),
    index('container_environment_config_idx').on(table.desiredConfigId),
  ],
);

export const rolesRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  users: many(userRoles),
}));

export const hostsRelations = relations(hosts, ({ many, one }) => ({
  containers: many(containers),
  composeProjects: many(composeProjects),
  agent: one(agents),
}));

export const agentsRelations = relations(agents, ({ one }) => ({
  host: one(hosts, { fields: [agents.hostId], references: [hosts.id] }),
}));

export const containersRelations = relations(containers, ({ one }) => ({
  host: one(hosts, { fields: [containers.hostId], references: [hosts.id] }),
  composeProject: one(composeProjects, {
    fields: [containers.composeProjectId],
    references: [composeProjects.id],
  }),
}));

export const stacksRelations = relations(stacks, ({ many, one }) => ({
  host: one(hosts, { fields: [stacks.hostId], references: [hosts.id] }),
  revisions: many(stackRevisions),
  deployments: many(stackDeployments),
  environment: many(stackEnvironmentVariables),
}));

export const stackDeploymentsRelations = relations(stackDeployments, ({ one }) => ({
  stack: one(stacks, { fields: [stackDeployments.stackId], references: [stacks.id] }),
  revision: one(stackRevisions, {
    fields: [stackDeployments.revisionId],
    references: [stackRevisions.id],
  }),
  host: one(hosts, { fields: [stackDeployments.hostId], references: [hosts.id] }),
}));

export const stackRevisionsRelations = relations(stackRevisions, ({ one }) => ({
  stack: one(stacks, { fields: [stackRevisions.stackId], references: [stacks.id] }),
}));

export const stackEnvironmentVariablesRelations = relations(
  stackEnvironmentVariables,
  ({ one }) => ({
    stack: one(stacks, { fields: [stackEnvironmentVariables.stackId], references: [stacks.id] }),
  }),
);

export const containerDesiredConfigsRelations = relations(
  containerDesiredConfigs,
  ({ many, one }) => ({
    container: one(containers, {
      fields: [containerDesiredConfigs.containerId],
      references: [containers.id],
    }),
    environment: many(containerEnvironmentVariables),
  }),
);

export const containerEnvironmentVariablesRelations = relations(
  containerEnvironmentVariables,
  ({ one }) => ({
    desiredConfig: one(containerDesiredConfigs, {
      fields: [containerEnvironmentVariables.desiredConfigId],
      references: [containerDesiredConfigs.id],
    }),
  }),
);

export type ContainerDesiredConfig = typeof containerDesiredConfigs.$inferSelect;
export type ContainerEnvironmentVariable = typeof containerEnvironmentVariables.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Host = typeof hosts.$inferSelect;
export type Container = typeof containers.$inferSelect;
export type ComposeProject = typeof composeProjects.$inferSelect;
export type Stack = typeof stacks.$inferSelect;
export type StackRevision = typeof stackRevisions.$inferSelect;
export type StackDeployment = typeof stackDeployments.$inferSelect;
export type AuditEntry = typeof auditEntries.$inferSelect;
