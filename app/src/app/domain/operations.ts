import { ActionStatus, AgentStatus, AuditResult, Severity } from './status';

/** Normalized operational event, as described in docs/design/APP_UI_SPEC.md. */
export interface OperationalEvent {
  readonly id: string;
  readonly time: string;
  readonly type: string;
  readonly severity: Severity;
  readonly hostId?: string;
  readonly resource: string;
  readonly message: string;
  readonly correlationId: string;
}

/** An authorized operational request and its outcome. */
export interface OperationAction {
  readonly id: string;
  readonly requestedAt: string;
  readonly capability: string;
  readonly summary: string;
  readonly target: string;
  readonly hostId?: string;
  /** Operator name, or `System` for control-server initiated work. */
  readonly actor: string;
  readonly durationMs?: number;
  readonly status: ActionStatus;
  readonly requestId: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface Agent {
  readonly id: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly version?: string;
  readonly status: AgentStatus;
  readonly connected: boolean;
  readonly lastSeen?: string;
  readonly enrolledAt: string;
  readonly protocolVersion: number;
  readonly certificateNotAfter: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

/**
 * A newly issued enrollment token.
 *
 * The raw value exists only in this response. Only its digest is stored, so it
 * cannot be shown again, and the interface never puts it anywhere it could be
 * read back.
 */
export interface EnrollmentToken {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly time: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly result: AuditResult;
  readonly source?: string;
  readonly requestId?: string;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  /** Cursor for the next page; absent on the last one. */
  readonly nextBefore?: string;
}

export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly roleIds: readonly string[];
  readonly roleNames: readonly string[];
  readonly mfaEnabled: boolean;
  readonly status: 'active' | 'disabled';
  readonly lastLogin?: string;
  readonly createdAt: string;
}

export interface Role {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly permissions: readonly string[];
  readonly builtIn: boolean;
}
