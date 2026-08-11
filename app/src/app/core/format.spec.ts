import { bytes, duration, relativeTime, uptime } from './format';

describe('format', () => {
  const now = new Date('2026-08-08T12:00:00Z').getTime();
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('reports recent timestamps in seconds', () => {
    expect(relativeTime(ago(10_000), now)).toBe('10s ago');
  });

  it('steps up through minutes, hours and days', () => {
    expect(relativeTime(ago(8 * 60_000), now)).toBe('8m ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe('2d ago');
  });

  it('never reports a negative age for a future timestamp', () => {
    expect(relativeTime(new Date(now + 60_000).toISOString(), now)).toBe('0s ago');
  });

  it('formats uptime coarsely', () => {
    expect(uptime(12 * 86_400 + 4 * 3600)).toBe('12d 4h');
    expect(uptime(3 * 3600 + 25 * 60)).toBe('3h 25m');
    expect(uptime(90)).toBe('1m');
  });

  it('leaves uptime undefined when the host is not reporting', () => {
    expect(uptime(undefined)).toBeUndefined();
  });

  it('formats durations', () => {
    expect(duration(640)).toBe('640ms');
    expect(duration(2400)).toBe('2.4s');
    expect(duration(90_000)).toBe('1m 30s');
    expect(duration(undefined)).toBeUndefined();
  });

  it('formats byte sizes', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1024)).toBe('1.0 KB');
    expect(bytes(1_180_000_000)).toBe('1.1 GB');
  });
});
