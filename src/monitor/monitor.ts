import { healthCheck } from '../anilist/healthCheck.js';
import type { HealthResult } from '../anilist/types.js';
import { JsonDatabase } from '../storage/database.js';
import { Logger } from '../utils/logger.js';
import { evaluateTransition } from './state.js';

export interface MonitorOptions {
  anilistUrl: string;
  requestTimeoutMs: number;
  historyLimit: number;
  rateLimitBackoffSeconds: number;
  maxRateLimitBackoffSeconds: number;
}

export type MonitorEvent = { type: 'ALERT' | 'RECOVERY'; result: HealthResult; outageStartedAt: number };

export class Monitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rateLimitUntil = 0;

  constructor(private readonly db: JsonDatabase, private readonly logger: Logger, private readonly onEvent: (event: MonitorEvent) => Promise<void>, private readonly options: MonitorOptions, private readonly onCheck: (result: HealthResult) => Promise<void> = async () => {}) {}

  async checkOnce(force = false): Promise<HealthResult | null> {
    if (!force && Date.now() < this.rateLimitUntil) {
      const waitSeconds = Math.ceil((this.rateLimitUntil - Date.now()) / 1000);
      this.logger.debug('Skipping AniList check during rate-limit backoff.', { waitSeconds });
      return null;
    }
    const result = await healthCheck(this.options.anilistUrl, this.options.requestTimeoutMs);
    if (result.status === 'RATE_LIMITED') {
      const backoff = Math.min(result.retryAfterSeconds ?? this.options.rateLimitBackoffSeconds, this.options.maxRateLimitBackoffSeconds);
      this.rateLimitUntil = Date.now() + backoff * 1000;
      this.logger.warn('AniList rate limit detected; backing off.', { backoffSeconds: backoff });
    }
    await this.process(result);
    await this.onCheck(result);
    return result;
  }

  private async process(result: HealthResult): Promise<void> {
    const before = this.db.snapshot;
    await this.db.applyCheck(result, this.options.historyLimit);
    const after = this.db.snapshot;
    const transition = evaluateTransition(before.currentStatus, before.outageStartedAt, after.consecutiveFailures, after.consecutiveSuccesses, after.config.failureThreshold, after.config.recoveryThreshold, result);
    if (transition.kind === 'ALERT' && before.outageStartedAt === null) {
      const history = after.history.slice(-after.config.failureThreshold);
      const outageStartedAt = history[0]?.at ?? result.checkedAt;
      await this.db.setOutage(outageStartedAt, null);
      await this.onEvent({ type: 'ALERT', result, outageStartedAt });
    } else if (transition.kind === 'RECOVERY' && before.outageStartedAt !== null) {
      await this.onEvent({ type: 'RECOVERY', result, outageStartedAt: before.outageStartedAt });
      await this.db.setOutage(null, null);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.checkOnce();
    this.schedule();
    this.logger.info('AniList monitoring started.', { intervalSeconds: this.db.snapshot.config.intervalSeconds });
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try { await this.checkOnce(); }
      catch (error) { this.logger.error('Unexpected monitoring error.', { error: error instanceof Error ? error.message : String(error) }); }
      finally { this.schedule(); }
    }, this.db.snapshot.config.intervalSeconds * 1000);
  }

  restart(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
