import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/worker/ratelimit';

describe('RateLimiter', () => {
  it('allows up to the limit per key within a minute, then refuses until the window slides', () => {
    const l = new RateLimiter(2);
    expect(l.allow('a', 0)).toBe(true);
    expect(l.allow('a', 1000)).toBe(true);
    expect(l.allow('a', 2000)).toBe(false);
    expect(l.allow('b', 2000)).toBe(true);
    expect(l.allow('a', 60_001)).toBe(true);
    expect(l.allow('a', 60_002)).toBe(false);
  });

  it('a limit of 0 disables it', () => {
    const l = new RateLimiter(0);
    for (let i = 0; i < 20; i++) expect(l.allow('a', i)).toBe(true);
  });
});
