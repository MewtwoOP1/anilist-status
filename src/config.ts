import 'dotenv/config';
import { LogLevel } from './utils/logger.js';

const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 86400;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;

function messageEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value == null ? fallback : value.replace(/\\n/g, '\n');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

function nonNegativeInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be a non-negative integer <= ${max}.`);
  return value;
}

const logLevel = (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as LogLevel;
if (!(logLevel in { error: 1, warn: 1, info: 1, debug: 1 })) throw new Error('LOG_LEVEL must be error, warn, info, or debug.');

export const config = {
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: process.env.DISCORD_CLIENT_ID?.trim() || undefined,
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
  anilistUrl: process.env.ANILIST_URL?.trim() || 'https://graphql.anilist.co',
  requestTimeoutMs: int('REQUEST_TIMEOUT', 10000, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
  checkIntervalSeconds: int('CHECK_INTERVAL', 60, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS),
  failureThreshold: int('FAILURE_THRESHOLD', 2, 1, 20),
  recoveryThreshold: int('RECOVERY_THRESHOLD', 2, 1, 20),
  channelId: process.env.DISCORD_CHANNEL_ID?.trim() || undefined,
  statusChannelId: process.env.DISCORD_STATUS_CHANNEL_ID?.trim() || undefined,
  roleId: process.env.DISCORD_ROLE_ID?.trim() || undefined,
  alertMessage: messageEnv('ALERT_MESSAGE', 'AniList API is currently unavailable. We cannot do anything about the upstream outage, and apps using AniList may not work properly.\n\nStatus: {status}\nHTTP: {http_status}\nResponse time: {response_time}\nDetails: {error}\nDetected: {timestamp}\n{retry_after}'),
  recoveryMessage: messageEnv('RECOVERY_MESSAGE', 'AniList API has recovered and is responding normally again.\n\nStatus: {status}\nResponse time: {response_time}\nDowntime: {downtime}\nRecovered: {timestamp}'),
  logLevel,
  stateFile: process.env.STATE_FILE?.trim() || './data/state.json',
  historyLimit: nonNegativeInt('HISTORY_LIMIT', 500, 5000),
  rateLimitBackoffSeconds: int('RATE_LIMIT_BACKOFF', 120, 30, 3600),
  maxRateLimitBackoffSeconds: int('MAX_RATE_LIMIT_BACKOFF', 600, 60, 86400),
  minIntervalSeconds: MIN_INTERVAL_SECONDS
};

if (config.maxRateLimitBackoffSeconds < config.rateLimitBackoffSeconds) throw new Error('MAX_RATE_LIMIT_BACKOFF must be >= RATE_LIMIT_BACKOFF.');
if (!/^https?:\/\//.test(config.anilistUrl)) throw new Error('ANILIST_URL must be an HTTP(S) URL.');
