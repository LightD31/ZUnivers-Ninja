const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel) {
  threshold = level;
}

function log(level: LogLevel, message: string, extra?: unknown) {
  if (LEVELS.indexOf(level) < LEVELS.indexOf(threshold)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export const logger = {
  debug: (m: string, e?: unknown) => log('debug', m, e),
  info: (m: string, e?: unknown) => log('info', m, e),
  warn: (m: string, e?: unknown) => log('warn', m, e),
  error: (m: string, e?: unknown) => log('error', m, e),
};
