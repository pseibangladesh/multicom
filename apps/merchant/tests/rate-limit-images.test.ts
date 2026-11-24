/**
 * Image reads are not rate limited (a product gallery would exceed the
 * /v1/images limit); uploads and deletes still are.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { rateLimitMiddleware } from '../src/middleware/rate-limit';
import { rateLimits } from '../src/config/rate-limits';
import { ApiError } from '../src/types';

function app() {
  const a = new Hono();
  a.onError((err, c) => c.json({}, (err instanceof ApiError ? err.statusCode : 500) as 429));
  a.use('/v1/*', rateLimitMiddleware());
  a.get('/v1/images/:key', (c) => c.text('img'));
  a.post('/v1/images', (c) => c.json({ ok: true }));
  return a;
}
const LIMIT = rateLimits.endpoints['/v1/images'].requests;

describe('rate limit and images', () => {
  it('never limits image downloads', async () => {
    const a = app();
    const ip = { 'CF-Connecting-IP': '203.0.113.7' };
    for (let i = 0; i < LIMIT * 3; i++) {
      const r = await a.request(`/v1/images/p${i}.webp`, { headers: ip });
      expect(r.status).toBe(200);
    }
  });

  it('still limits uploads', async () => {
    const a = app();
    const ip = { 'CF-Connecting-IP': '203.0.113.8' };
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 2; i++) statuses.push((await a.request('/v1/images', { method: 'POST', headers: ip })).status);
    expect(statuses.slice(0, LIMIT).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
