import type { HealthResult, HealthStatus } from '../anilist/types.js';

export interface Transition {
  kind: 'ALERT' | 'RECOVERY' | 'NONE';
  status: HealthStatus;
  outageStartedAt: number | null;
}

export function evaluateTransition(currentStatus: HealthStatus, outageStartedAt: number | null, consecutiveFailures: number, consecutiveSuccesses: number, failureThreshold: number, recoveryThreshold: number, result: HealthResult): Transition {
  if (result.status === 'HEALTHY') {
    if (outageStartedAt !== null && consecutiveSuccesses >= recoveryThreshold) return { kind: 'RECOVERY', status: 'HEALTHY', outageStartedAt };
    return { kind: 'NONE', status: currentStatus, outageStartedAt };
  }
  if (outageStartedAt === null && consecutiveFailures >= failureThreshold) return { kind: 'ALERT', status: result.status, outageStartedAt: result.checkedAt - (failureThreshold - 1) * 0 };
  return { kind: 'NONE', status: currentStatus, outageStartedAt };
}
