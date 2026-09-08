import { describe, expect, it, beforeEach, vi } from 'vitest';
import { JsonDatabase, type PersistedConfig } from '../src/storage/database.js';
import { Monitor } from '../src/monitor/monitor.js';
import { Logger } from '../src/utils/logger.js';
import type { HealthResult } from '../src/anilist/types.js';

const defaults: PersistedConfig = { intervalSeconds: 60, failureThreshold: 2, recoveryThreshold: 2, alertMessage: 'Alert {status}', recoveryMessage: 'Recovery {downtime}' };
const result = (status: HealthResult['status'], at: number): HealthResult => ({ status, checkedAt: at, responseTimeMs: 100, httpStatus: status === 'HEALTHY' ? 200 : 503, error: status === 'HEALTHY' ? null : 'failure', retryAfterSeconds: null, graphqlErrors: [] });

describe('persistent monitoring state', () => {
  let db: JsonDatabase;
  beforeEach(async () => { db = new JsonDatabase(`/tmp/anilist-monitor-test-${Math.random()}.json`, defaults, 20); await db.load(); });

  it('persists checks and computes rolling statistics', async () => {
    await db.applyCheck(result('HEALTHY', 1000), 20); await db.applyCheck(result('DOWN', 2000), 20);
    expect(db.snapshot.checks).toBe(2); expect(db.snapshot.successes).toBe(1); expect(db.snapshot.failures).toBe(1);
  });

  it('tracks consecutive failures and recovery', async () => {
    await db.applyCheck(result('DOWN', 1000), 20); expect(db.snapshot.consecutiveFailures).toBe(1);
    await db.applyCheck(result('DOWN', 2000), 20); expect(db.snapshot.consecutiveFailures).toBe(2);
    await db.applyCheck(result('HEALTHY', 3000), 20); expect(db.snapshot.consecutiveSuccesses).toBe(1); expect(db.snapshot.consecutiveFailures).toBe(0);
  });

  it('supports alert/recovery transition thresholds without duplicate events', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {}, errors: [{ message: 'failure' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {}, errors: [{ message: 'failure' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { Viewer: { id: 1 } } }), { status: 200 })));
    const monitor = new Monitor(db, new Logger('error'), async e => events.push(e.type), { anilistUrl: 'https://graphql.anilist.co', requestTimeoutMs: 1000, historyLimit: 20, rateLimitBackoffSeconds: 30, maxRateLimitBackoffSeconds: 60 });
    await monitor.checkOnce(); await monitor.checkOnce(); await monitor.checkOnce(); await monitor.checkOnce();
    expect(events).toEqual(['ALERT', 'RECOVERY']);
  });
});
