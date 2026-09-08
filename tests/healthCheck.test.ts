import { describe, expect, it, vi } from 'vitest';
import { healthCheck } from '../src/anilist/healthCheck.js';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('AniList health check', () => {
  it('classifies a healthy GraphQL response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ data: { Viewer: { id: 1 } } })));
    const result = await healthCheck('https://graphql.anilist.co', 1000);
    expect(result.status).toBe('HEALTHY');
  });
  it('classifies 429 and captures Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ message: 'rate limited' }, 429, { 'retry-after': '30' })));
    const result = await healthCheck('https://graphql.anilist.co', 1000);
    expect(result.status).toBe('RATE_LIMITED'); expect(result.retryAfterSeconds).toBe(30);
  });
  it('classifies AniList severe-stability 403 as down and preserves the GraphQL message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ errors: [{ message: 'The AniList API has been temporarily disabled due to severe stability issues. Please check the official AniList Discord for more information.' }] }, 403)));
    const result = await healthCheck('https://graphql.anilist.co', 1000);
    expect(result.status).toBe('DOWN');
    expect(result.httpStatus).toBe(403);
    expect(result.error).toContain('temporarily disabled due to severe stability issues');
  });
  it('classifies a generic 403 from the public AniList endpoint as down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, 403)));
    const result = await healthCheck('https://graphql.anilist.co', 1000);
    expect(result.status).toBe('DOWN');
    expect(result.httpStatus).toBe(403);
  });
  it('classifies 500 as down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({}, 500)));
    expect((await healthCheck('x', 1000)).status).toBe('DOWN');
  });
  it('classifies timeout as down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')));
    expect((await healthCheck('x', 1000)).status).toBe('DOWN');
  });
  it('classifies network errors as down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect((await healthCheck('x', 1000)).status).toBe('DOWN');
  });
  it('classifies GraphQL errors as API_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ data: {}, errors: [{ message: 'Something failed' }] })));
    expect((await healthCheck('x', 1000)).status).toBe('API_ERROR');
  });
  it('conservatively classifies explicit deprecation evidence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ data: {}, errors: [{ message: 'Field oldField has been removed from the schema' }] })));
    expect((await healthCheck('x', 1000)).status).toBe('DEPRECATED');
  });
});
