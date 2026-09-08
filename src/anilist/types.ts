export type HealthStatus = 'HEALTHY' | 'DOWN' | 'RATE_LIMITED' | 'API_ERROR' | 'DEPRECATED';

export interface HealthResult {
  status: HealthStatus;
  checkedAt: number;
  responseTimeMs: number;
  httpStatus: number | null;
  error: string | null;
  retryAfterSeconds: number | null;
  graphqlErrors: string[];
}

export interface GraphQLErrorShape {
  message?: unknown;
  extensions?: unknown;
}
