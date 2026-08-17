import { AppError } from '../common/errors';
import {
  STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION,
  assertStackAttribution,
  supportsStackAttribution,
} from './stack-attribution';

describe('whether an agent reports which stack its containers belong to', () => {
  it('accepts the release the support began in', () => {
    expect(supportsStackAttribution(STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION)).toBe(true);
  });

  it('accepts what comes after it, in version order rather than in text order', () => {
    expect(supportsStackAttribution('0.3.0-rc.3')).toBe(true);
    expect(supportsStackAttribution('0.3.0')).toBe(true);
    expect(supportsStackAttribution('0.10.0')).toBe(true);
    expect(supportsStackAttribution('1.0.0')).toBe(true);
  });

  it('refuses the releases that carried the defect', () => {
    expect(supportsStackAttribution('0.2.0')).toBe(false);
    expect(supportsStackAttribution('0.3.0-rc.1')).toBe(false);
  });

  /*
   * The version an agent reports carries the commit it was built from. It is
   * build metadata, which takes no part in precedence, and an agent that is
   * refused because of the commit in its own version string would be refused
   * for something that says nothing about what it can do.
   */
  it('ignores the build metadata an agent appends to its version', () => {
    expect(supportsStackAttribution(`${STACK_ATTRIBUTION_MINIMUM_AGENT_VERSION}+3061563`)).toBe(
      true,
    );
    expect(supportsStackAttribution('0.3.0-rc.1+3061563')).toBe(false);
  });

  /*
   * Fail closed. An agent that has never said what it is may be anything, and
   * the one thing the server may not do is assume the attribution will arrive
   * and then delete a stack because none did.
   */
  it('refuses an agent that has not said what it is', () => {
    expect(supportsStackAttribution(null)).toBe(false);
    expect(supportsStackAttribution(undefined)).toBe(false);
    expect(supportsStackAttribution('')).toBe(false);
    expect(supportsStackAttribution('latest')).toBe(false);
    expect(supportsStackAttribution('0.3')).toBe(false);
  });

  it('names the upgrade rather than the protocol when it refuses', () => {
    let thrown: AppError | undefined;

    try {
      assertStackAttribution('0.2.0', 'this stack cannot be removed');
    } catch (error) {
      thrown = error as AppError;
    }

    expect(thrown?.code).toBe('AGENT_UPGRADE_REQUIRED');
    expect(thrown?.message).toContain('this stack cannot be removed');
    expect(thrown?.message).not.toContain('protocol');
  });

  it('says nothing and returns when the agent is new enough', () => {
    expect(() => assertStackAttribution('0.3.0', 'the stack cannot be changed')).not.toThrow();
  });
});
