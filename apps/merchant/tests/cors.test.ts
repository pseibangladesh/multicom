/** CORS on the real app: an allowlist from STORE_URL / CORS_ORIGIN, never '*'. */
import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/types';

// routes/images.ts reads the Workers-only `caches` global at import time.
vi.stubGlobal('caches', { default: {} });
const { default: worker } = await import('../src/index');

const preflight = (origin: string, env: Partial<Env>) =>
  worker.fetch(
    new Request('https://api.shop.test/v1/products', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,content-type' },
    }),
    env as Env,
    {} as ExecutionContext,
  );

describe('CORS', () => {
  it('echoes an allowed origin with credentials', async () => {
    const res = await preflight('https://shop.test', { STORE_URL: 'https://shop.test/' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.test');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Headers')).toMatch(/authorization/i);
  });

  it('gives other origins no CORS headers at all (no * fallback)', async () => {
    const res = await preflight('https://evil.test', { STORE_URL: 'https://shop.test' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('CORS_ORIGIN lists several origins and overrides STORE_URL', async () => {
    const env = { STORE_URL: 'https://shop.test', CORS_ORIGIN: 'https://admin.shop.test, https://shop.test' };
    expect((await preflight('https://admin.shop.test', env)).headers.get('Access-Control-Allow-Origin')).toBe('https://admin.shop.test');
    expect((await preflight('https://shop.test', env)).headers.get('Access-Control-Allow-Origin')).toBe('https://shop.test');
  });

  it('fails closed when nothing is configured', async () => {
    expect((await preflight('https://shop.test', {})).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
