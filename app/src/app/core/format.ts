/** Presentation helpers shared across the operational views. */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age of a timestamp, for example `10s ago` or `8m ago`. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m ago`;
  }
  if (seconds < DAY) {
    return `${Math.floor(seconds / HOUR)}h ago`;
  }

  return `${Math.floor(seconds / DAY)}d ago`;
}

/** Coarse uptime, for example `12d 4h`. */
export function uptime(seconds: number | undefined): string | undefined {
  if (seconds === undefined) {
    return undefined;
  }

  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function duration(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined) {
    return undefined;
  }
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const seconds = milliseconds / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(value: number): string {
  let size = value;
  let unit = 0;

  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${UNITS[unit]}`;
}

/** Absolute timestamp for tables and audit views. */
export function timestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function clockTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
