export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const levels: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  constructor(private readonly minimum: LogLevel = 'info') {}

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (levels[level] > levels[this.minimum]) return;
    const entry = { time: new Date().toISOString(), level, message, ...(meta ?? {}) };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  error(message: string, meta?: Record<string, unknown>): void { this.write('error', message, meta); }
  warn(message: string, meta?: Record<string, unknown>): void { this.write('warn', message, meta); }
  info(message: string, meta?: Record<string, unknown>): void { this.write('info', message, meta); }
  debug(message: string, meta?: Record<string, unknown>): void { this.write('debug', message, meta); }
}
