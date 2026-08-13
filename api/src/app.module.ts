import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CsrfGuard } from './auth/csrf.guard';
import { AdminSessionsController, SessionsController } from './auth/sessions.controller';
import { SessionGuard } from './auth/session.guard';
import { SessionService } from './auth/session.service';
import { AgentCaService } from './agents/agent-ca.service';
import { AgentGatewayService } from './agents/agent-gateway.service';
import { AgentRegistryService } from './agents/agent-registry.service';
import { AgentConnectionManager } from './agents/connection-manager.service';
import { AgentDispatchService } from './agents/agent-dispatch.service';
import { PendingMutationGuard } from './containers/pending-guard';
import { RecoveryFinalizer } from './containers/recovery-finalizer';
import { DetailService } from './discovery/detail.service';
import { DiscoveryService } from './discovery/discovery.service';
import { EventsService } from './events/events.service';
import { InventoryService } from './inventory/inventory.service';
import { ContainerLogsController } from './logs/logs.controller';
import { LogStreamService } from './logs/log-stream.service';
import { LifecycleService } from './operations/lifecycle.service';
import { MutationRegistry } from './operations/mutation-registry';
import {
  ActionsController,
  ContainerOperationsController,
} from './operations/operations.controller';
import {
  ComposeProjectsController,
  ContainersController,
  HostsController,
} from './inventory/inventory.controller';
import { DiscoveryScheduler } from './discovery/discovery.scheduler';
import { EnrollmentService } from './agents/enrollment.service';
import { AgentEnrollmentController, AgentsController } from './agents/agents.controller';
import {
  HostBootstrapController,
  HostSetupController,
} from './host-setup/host-setup.controller';
import { HostSetupService } from './host-setup/host-setup.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AppConfigModule } from './config/config.module';
import { AppConfig, CONFIG } from './config/configuration';
import { Database } from './database/database';
import { HealthController } from './health/health.controller';
import { VersionController } from './version/version.controller';
import { RequestContextMiddleware } from './logging/request-context.middleware';
import { MfaController } from './mfa/mfa.controller';
import { MfaService } from './mfa/mfa.service';
import { PermissionsGuard } from './rbac/permissions.guard';
import { RbacService } from './rbac/rbac.service';
import { RolesController, UsersController } from './users/users.controller';
import { SECRET_BOX } from './config/tokens';
import { SecretBox } from './common/crypto';

/**
 * Guard order matters and is fixed here.
 *
 * The session guard runs first so identity exists; CSRF then validates the
 * mutation against that session; the permission guard decides last. Registering
 * all three globally means a new controller is protected by default and has to
 * opt out explicitly.
 */
@Module({
  imports: [
    AppConfigModule,
    /*
     * Two windows. The default bounds ordinary traffic; the credentials window
     * is much tighter and is applied only to the endpoints that accept a
     * password or a second-factor code. Both slide, so nothing is ever locked
     * permanently and a wrong guess cannot be used to deny someone access.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', limit: 300, ttl: 60_000 },
        { name: 'credentials', limit: 10, ttl: 300_000 },
      ],
    }),
  ],
  controllers: [
    HealthController,
    VersionController,
    AuthController,
    SessionsController,
    AdminSessionsController,
    MfaController,
    AuditController,
    UsersController,
    RolesController,
    AgentsController,
    AgentEnrollmentController,
    HostSetupController,
    HostBootstrapController,
    HostsController,
    ContainersController,
    ComposeProjectsController,
    ContainerOperationsController,
    ContainerLogsController,
    ActionsController,
  ],
  providers: [
    {
      provide: SessionService,
      useFactory: (db: Database, config: AppConfig) => new SessionService(db, config),
      inject: [Database, CONFIG],
    },
    {
      provide: MfaService,
      useFactory: (db: Database, box: SecretBox) => new MfaService(db, box),
      inject: [Database, SECRET_BOX],
    },
    RbacService,
    AuditService,
    AuthService,
    AgentCaService,
    AgentRegistryService,
    AgentConnectionManager,
    AgentDispatchService,
    DiscoveryService,
    DetailService,
    EventsService,
    InventoryService,
    MutationRegistry,
    PendingMutationGuard,
    RecoveryFinalizer,
    LifecycleService,
    LogStreamService,
    DiscoveryScheduler,
    EnrollmentService,
    HostSetupService,
    AgentGatewayService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
