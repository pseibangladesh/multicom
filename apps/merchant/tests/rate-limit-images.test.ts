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

describe('rate limit identity', () => {
  function api() {
    const a = new Hono();
    a.onError((err, c) => c.json({}, (err instanceof ApiError ? err.statusCode : 500) as 429));
    a.use('/v1/*', rateLimitMiddleware());
    a.get('/v1/orders', (c) => c.json({ ok: true }));
    return a;
  }
  const PK = 'pk_' + 'c'.repeat(48);

  it('counts the shared public key per shopper, not for the whole store', async () => {
    const a = api();
    const limit = rateLimits.roles.public.requests;
    const shopperA = { Authorization: `Bearer ${PK}`, 'CF-Connecting-IP': '198.51.100.1' };
    const shopperB = { Authorization: `Bearer ${PK}`, 'CF-Connecting-IP': '198.51.100.2' };
    for (let i = 0; i < limit; i++) expect((await a.request('/v1/orders', { headers: shopperA })).status).toBe(200);
    expect((await a.request('/v1/orders', { headers: shopperA })).status).toBe(429);
    // Same key, another shopper: unaffected.
    expect((await a.request('/v1/orders', { headers: shopperB })).status).toBe(200);
  });

  it('gives signed-in browsers the session limit', async () => {
    const a = api();
    const headers = { cookie: 'better-auth.session_token=abc.def', 'CF-Connecting-IP': '198.51.100.3' };
    const r = await a.request('/v1/orders', { headers });
    expect(r.headers.get('X-RateLimit-Limit')).toBe(String(rateLimits.roles.session.requests));
    // Past the anonymous default (100), a session is still served.
    for (let i = 0; i < rateLimits.default.requests + 5; i++) await a.request('/v1/orders', { headers });
    expect((await a.request('/v1/orders', { headers })).status).toBe(200);
  });
});
