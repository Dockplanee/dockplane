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
    ...timestamps,
  },
  (table) => [index('hosts_hostname_idx').on(table.hostname)],
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
    /** Docker IDs are only unique per host, so identity is host-scoped. */
    dockerId: text('docker_id').notNull(),
    name: text('name').notNull(),
    image: text('image').notNull(),
    imageId: text('image_id'),
    state: text('state').notNull(),
    health: text('health').notNull().default('none'),
    restartCount: integer('restart_count').notNull().default(0),
    composeProjectId: uuid('compose_project_id'),
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
     * The last complete discovery that saw this container.
     *
     * Reconciliation removes rows only when a snapshot finished, so a sync that
     * failed halfway cannot make surviving containers look deleted.
     */
    snapshotId: uuid('snapshot_id'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('containers_host_docker_id_unique').on(table.hostId, table.dockerId)],
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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type Host = typeof hosts.$inferSelect;
export type Container = typeof containers.$inferSelect;
export type ComposeProject = typeof composeProjects.$inferSelect;
export type AuditEntry = typeof auditEntries.$inferSelect;
