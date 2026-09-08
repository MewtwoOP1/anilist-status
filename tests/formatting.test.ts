import { describe, expect, it } from 'vitest';
import { formatDuration, replacePlaceholders } from '../src/utils/formatting.js';

describe('formatting', () => {
  it('calculates downtime duration', () => expect(formatDuration(4 * 60_000 + 17_000)).toBe('4m 17s'));
  it('replaces known placeholders and leaves unknown ones intact', () => expect(replacePlaceholders('Status {status} {unknown}', { status: 'DOWN' })).toBe('Status DOWN {unknown}'));
});
