import type { AgentConfig } from './types.ts';

export class Logger {
  private level: number;
  private prefix: string;

  private static LEVELS: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(config: AgentConfig, prefix = 'Agent') {
    this.level = Logger.LEVELS[config.logLevel] ?? 1;
    this.prefix = prefix;
  }

  private log(level: string, message: string, ...args: unknown[]): void {
    const levelNum = Logger.LEVELS[level] ?? 1;
    if (levelNum < this.level) return;

    const timestamp = new Date().toISOString();
    const formatted = args.length > 0 ? args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : '';
    console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.prefix}] ${message}${formatted ? ' ' + formatted : ''}`);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }
}
