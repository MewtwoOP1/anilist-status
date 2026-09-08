import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HealthResult } from '../anilist/types.js';

export interface PersistedConfig {
  channelId: string | null;
  statusChannelId: string | null;
  statusMessageId?: string | null;
  roleId: string | null;
  alertMessage: string;
  recoveryMessage: string;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
}

export interface PersistedState {
  config: PersistedConfig;
  outageStartedAt: number | null;
  outageAlertMessageId: string | null;
  currentStatus: HealthResult['status'];
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheck: HealthResult | null;
  lastSuccessfulAt: number | null;
  lastFailedAt: number | null;
  checks: number;
  successes: number;
  failures: number;
  rateLimits: number;
  apiErrors: number;
  deprecated: number;
  responseTimeTotalMs: number;
  history: Array<{ at: number; status: HealthResult['status']; responseTimeMs: number; httpStatus: number | null; error: string | null }>;
}

export class JsonDatabase {
  private state: PersistedState;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, defaults: PersistedConfig, historyLimit: number) {
    this.state = this.defaultState(defaults, historyLimit);
  }

  private defaultState(config: PersistedConfig, _historyLimit: number): PersistedState {
    return { config: { statusMessageId: null, ...config }, outageStartedAt: null, outageAlertMessageId: null, currentStatus: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses: 0, lastCheck: null, lastSuccessfulAt: null, lastFailedAt: null, checks: 0, successes: 0, failures: 0, rateLimits: 0, apiErrors: 0, deprecated: 0, responseTimeTotalMs: 0, history: [] };
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = { ...this.state, ...parsed, config: { ...this.state.config, ...(parsed.config ?? {}) }, history: Array.isArray(parsed.history) ? parsed.history : [] };
      // Migrate the previous built-in templates so an existing state file receives the refined defaults.
      const legacyAlert = '🚨 AniList API Alert\nStatus: {status}\nHTTP: {http_status}\nResponse time: {response_time}\nError: {error}\nDetected: {timestamp}\n{retry_after}';
      const legacyRecovery = '✅ AniList API has recovered.\n\nStatus: {status}\nResponse time: {response_time}\nDowntime: {downtime}\nRecovered: {timestamp}';
      if (this.state.config.alertMessage === legacyAlert) this.state.config.alertMessage = 'AniList API is currently unavailable. We cannot do anything about the upstream outage, and apps using AniList may not work properly.\n\nStatus: {status}\nHTTP: {http_status}\nResponse time: {response_time}\nDetails: {error}\nDetected: {timestamp}\n{retry_after}';
      if (this.state.config.recoveryMessage === legacyRecovery) this.state.config.recoveryMessage = 'AniList API has recovered and is responding normally again.\n\nStatus: {status}\nResponse time: {response_time}\nDowntime: {downtime}\nRecovered: {timestamp}';
      await this.persist();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  get snapshot(): PersistedState { return structuredClone(this.state); }

  async updateConfig(patch: Partial<PersistedConfig>): Promise<void> {
    this.state.config = { ...this.state.config, ...patch };
    await this.persist();
  }

  async applyCheck(result: HealthResult, historyLimit: number): Promise<void> {
    this.state.lastCheck = result;
    this.state.checks++;
    this.state.responseTimeTotalMs += result.responseTimeMs;
    if (result.status === 'HEALTHY') { this.state.successes++; this.state.lastSuccessfulAt = result.checkedAt; this.state.consecutiveSuccesses++; this.state.consecutiveFailures = 0; }
    else { this.state.failures++; this.state.lastFailedAt = result.checkedAt; this.state.consecutiveFailures++; this.state.consecutiveSuccesses = 0; }
    if (result.status === 'RATE_LIMITED') this.state.rateLimits++;
    if (result.status === 'API_ERROR') this.state.apiErrors++;
    if (result.status === 'DEPRECATED') this.state.deprecated++;
    this.state.currentStatus = result.status;
    this.state.history.push({ at: result.checkedAt, status: result.status, responseTimeMs: result.responseTimeMs, httpStatus: result.httpStatus, error: result.error });
    if (this.state.history.length > historyLimit) this.state.history = this.state.history.slice(-historyLimit);
    await this.persist();
  }

  async setOutage(startedAt: number | null, alertMessageId: string | null): Promise<void> { this.state.outageStartedAt = startedAt; this.state.outageAlertMessageId = alertMessageId; await this.persist(); }


  private async persist(): Promise<void> {
    const data = JSON.stringify(this.state, null, 2);
    const tmp = `${this.path}.tmp`;
    this.writeChain = this.writeChain.then(async () => { await mkdir(dirname(this.path), { recursive: true }); await writeFile(tmp, data, 'utf8'); await rename(tmp, this.path); });
    await this.writeChain;
  }
}
