import type { GraphQLErrorShape, HealthResult } from './types.js';
import { classifyGraphQLErrors } from './classifier.js';

const HEALTH_QUERY = `query AniListMonitorHealth { Page(page: 1, perPage: 1) { pageInfo { total } } }`;

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Request timed out.';
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'Network request failed.';
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

export async function healthCheck(url: string, timeoutMs: number): Promise<HealthResult> {
  const started = performance.now();
  const checkedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ query: HEALTH_QUERY }),
      signal: controller.signal
    });
    const responseTimeMs = performance.now() - started;
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      if (response.status === 429) return { status: 'RATE_LIMITED', checkedAt, responseTimeMs, httpStatus: 429, error: 'AniList rate limited the request.', retryAfterSeconds, graphqlErrors: [] };
      if (response.status >= 500) return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: response.status, error: `AniList server returned HTTP ${response.status}.`, retryAfterSeconds, graphqlErrors: [] };
      return { status: response.ok ? 'DOWN' : 'API_ERROR', checkedAt, responseTimeMs, httpStatus: response.status, error: response.ok ? 'AniList returned malformed JSON.' : `AniList returned HTTP ${response.status}.`, retryAfterSeconds, graphqlErrors: [] };
    }

    const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const errors = record && Array.isArray(record.errors) ? record.errors as GraphQLErrorShape[] : [];
    const errorMessages = errors.map(e => typeof e.message === 'string' ? e.message : '').filter(Boolean);
    const combinedError = errorMessages.join('; ');
    const severeOutage = response.status === 403 && /temporarily disabled due to severe stability issues/i.test(combinedError);

    if (response.status === 429) return { status: 'RATE_LIMITED', checkedAt, responseTimeMs, httpStatus: 429, error: combinedError || 'AniList rate limited the request.', retryAfterSeconds, graphqlErrors: errorMessages.slice(0, 10) };
    // AniList uses HTTP 403 when the public API is temporarily disabled during severe stability incidents.
    // Treat any 403 from the public GraphQL endpoint as DOWN from an application-health perspective,
    // while preserving the upstream GraphQL message when one is available.
    if (severeOutage || response.status === 403) return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: 403, error: combinedError || 'AniList API returned HTTP 403 and is unavailable to clients.', retryAfterSeconds, graphqlErrors: errorMessages.slice(0, 10) };
    if (response.status >= 500) return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: response.status, error: combinedError || `AniList server returned HTTP ${response.status}.`, retryAfterSeconds, graphqlErrors: errorMessages.slice(0, 10) };
    if (!response.ok) return { status: 'API_ERROR', checkedAt, responseTimeMs, httpStatus: response.status, error: combinedError || `AniList returned HTTP ${response.status}.`, retryAfterSeconds, graphqlErrors: errorMessages.slice(0, 10) };

    if (!record) return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: response.status, error: 'AniList returned an unusable response.', retryAfterSeconds, graphqlErrors: [] };

    if (errors.length > 0) {
      const classified = classifyGraphQLErrors(errors);
      return { status: classified.status, checkedAt, responseTimeMs, httpStatus: response.status, error: classified.error, retryAfterSeconds, graphqlErrors: errors.map(e => typeof e.message === 'string' ? e.message : 'Unknown GraphQL error').slice(0, 10) };
    }
    if (!record.data || typeof record.data !== 'object') return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: response.status, error: 'AniList response did not contain GraphQL data.', retryAfterSeconds, graphqlErrors: [] };
    return { status: 'HEALTHY', checkedAt, responseTimeMs, httpStatus: response.status, error: null, retryAfterSeconds, graphqlErrors: [] };
  } catch (error) {
    const responseTimeMs = performance.now() - started;
    return { status: 'DOWN', checkedAt, responseTimeMs, httpStatus: null, error: safeErrorMessage(error), retryAfterSeconds: null, graphqlErrors: [] };
  } finally { clearTimeout(timer); }
}
