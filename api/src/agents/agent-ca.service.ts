import { readFileSync, statSync } from 'node:fs';

import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Logger } from 'pino';

import { AppConfig, CONFIG } from '../config/configuration';
import { LOGGER } from '../config/tokens';
import { AgentCertificateAuthority, IssuedCertificate } from './pki';

/**
 * The agent certificate authority in production use.
 *
 * The CA is the root of device trust: anything it signs may connect to the
 * gateway. Three rules follow from that and are enforced here.
 *
 * The key is read from an explicit file path and never from the database, so a
 * database disclosure does not yield the ability to mint agent identities.
 *
 * A missing or unreadable CA is fatal at startup rather than something the
 * server works around. Generating one implicitly would silently replace the
 * trust anchor and invalidate every enrolled agent, so that only ever happens
 * through the deliberate setup command.
 *
 * Neither the key nor its passphrase is ever logged, including in the errors
 * raised from here.
 */
@Injectable()
export class AgentCaService implements OnModuleInit {
  private authority?: AgentCertificateAuthority;
  private caCertificatePem = '';

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  /** Certificate chain an agent needs to trust the control plane. */
  get chainPem(): string {
    return this.caCertificatePem;
  }

  async issueAgentCertificate(csrPem: string, agentId: string): Promise<IssuedCertificate> {
    return this.requireAuthority().issueAgentCertificate(
      csrPem,
      agentId,
      this.config.AGENT_CERT_TTL,
    );
  }

  private requireAuthority(): AgentCertificateAuthority {
    if (!this.authority) {
      throw new Error('The agent certificate authority is not loaded');
    }

    return this.authority;
  }

  private async load(): Promise<void> {
    const certPath = this.config.AGENT_CA_CERT_PATH;
    const keyPath = this.config.AGENT_CA_KEY_PATH;

    let certificatePem: string;
    let privateKeyPem: string;

    try {
      certificatePem = readFileSync(certPath, 'utf8');
      privateKeyPem = readFileSync(keyPath, 'utf8');
    } catch {
      // The path is named so an operator can fix it; the contents are not.
      throw new Error(
        `The agent certificate authority could not be read from ${certPath} and ${keyPath}. ` +
          'Create it with "npm run setup:agent-ca" and point AGENT_CA_CERT_PATH and ' +
          'AGENT_CA_KEY_PATH at the result.',
      );
    }

    try {
      this.authority = await AgentCertificateAuthority.load({
        certificatePem,
        privateKeyPem,
        passphrase: this.config.AGENT_CA_KEY_PASSPHRASE,
      });
    } catch {
      throw new Error(
        'The agent certificate authority could not be loaded. Check that the key matches the ' +
          'certificate and that AGENT_CA_KEY_PASSPHRASE is correct.',
      );
    }

    this.caCertificatePem = certificatePem;
    this.warnAboutKeyPermissions(keyPath);

    this.logger.info({ event: 'agent_ca_loaded' }, 'agent certificate authority loaded');
  }

  /**
   * A CA key readable by other accounts on the host is a finding, not a
   * failure: refusing to start would be worse than running while an operator
   * fixes the mode.
   */
  private warnAboutKeyPermissions(keyPath: string): void {
    try {
      const mode = statSync(keyPath).mode & 0o077;

      if (mode !== 0) {
        this.logger.warn(
          { event: 'agent_ca_key_permissions', path: keyPath },
          'the agent CA private key is readable beyond its owner; restrict it to 0600',
        );
      }
    } catch {
      // Permission reporting is diagnostic only and must not block startup.
    }
  }
}
