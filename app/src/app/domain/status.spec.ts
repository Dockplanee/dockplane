import {
  actionStatus,
  agentStatus,
  composeState,
  containerHealth,
  containerState,
  hostStatus,
  isReporting,
  severity,
} from './status';

describe('status vocabulary', () => {
  it('gives every host status a label', () => {
    for (const value of ['healthy', 'warning', 'critical', 'offline', 'unknown'] as const) {
      expect(hostStatus(value).label.length).toBeGreaterThan(0);
    }
  });

  it('maps operational states onto the shared tones', () => {
    expect(containerState('running').tone).toBe('ok');
    expect(containerState('failed').tone).toBe('critical');
    expect(containerHealth('unhealthy').tone).toBe('critical');
    expect(composeState('degraded').tone).toBe('warn');
    expect(agentStatus('disconnected').tone).toBe('critical');
    expect(actionStatus('timed-out').tone).toBe('critical');
    expect(severity('info').tone).toBe('info');
  });

  it('treats offline and unknown hosts as not reporting', () => {
    expect(isReporting('healthy')).toBe(true);
    expect(isReporting('warning')).toBe(true);
    expect(isReporting('offline')).toBe(false);
    expect(isReporting('unknown')).toBe(false);
  });
});
