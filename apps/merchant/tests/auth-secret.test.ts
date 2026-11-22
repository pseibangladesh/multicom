import { describe, it, expect } from 'vitest';
import { assertAuthSecret } from '../src/lib/auth';

describe('assertAuthSecret', () => {
  it('rejects missing, blank and short secrets without echoing them', () => {
    for (const bad of [undefined, '', ' '.repeat(40), 'short-secret']) {
      expect(() => assertAuthSecret(bad)).toThrow(/BETTER_AUTH_SECRET must be set to at least 32 characters/);
    }
    try {
      assertAuthSecret('hunter2-hunter2');
    } catch (e) {
      expect(String(e)).not.toContain('hunter2');
    }
  });

  it('accepts a 32+ character secret', () => {
    const s = 'x'.repeat(32);
    expect(assertAuthSecret(s)).toBe(s);
  });
});
