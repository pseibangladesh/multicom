/**
 * Full Better Auth flow through the real MerchantDO (real schema + migrations)
 * on node:sqlite: the same path the Worker takes when it forwards /api/auth/*.
 */
import { describe, it, expect } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { allowedOrigins, verifySession } from '../src/lib/session';

const API = 'http://localhost:8787';
const STORE = 'http://localhost:5173';

let ipCounter = 0;

function setup(env: Record<string, string> = {}) {
  // Better Auth's in-memory rate limiter is keyed by client IP and shared
  // across instances; a distinct IP per test keeps tests independent.
  const ip = `10.0.0.${++ipCounter}`;
  const { merchant } = createMerchantDb({
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
    API_BASE_URL: API,
    CORS_ORIGIN: STORE,
    ...env,
  });

  const call = (method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string } = {}) =>
    merchant.fetch(
      new Request(API + path, {
        method,
        headers: {
          'content-type': 'application/json',
          origin: opts.origin ?? STORE,
          'cf-connecting-ip': ip,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
    );

  /** Turns Set-Cookie headers into a Cookie request header. */
  const cookieFrom = (res: Response) =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  const signUp = (email = 'buyer@example.com', password = 'password123') =>
    call('POST', '/api/auth/sign-up/email', { body: { name: 'Buyer', email, password } });

  return { merchant, call, cookieFrom, signUp };
}

describe('Better Auth inside MerchantDO', () => {
  it('signs up and returns a signed HttpOnly session cookie', async () => {
    const { signUp } = setup();
    const res = await signUp();
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/better-auth\.session_token=[^;]+\.[^;]+;/); // token.signature
    expect(setCookie).toContain('HttpOnly');
  });

  it('GET /api/auth/session returns the user for the cookie, null without it', async () => {
    const { call, cookieFrom, signUp } = setup();
    const cookie = cookieFrom(await signUp());

    const withCookie = await (await call('GET', '/api/auth/session', { cookie })).json();
    expect(withCookie.session.user).toMatchObject({ email: 'buyer@example.com', name: 'Buyer', is_admin: false });

    const without = await (await call('GET', '/api/auth/session')).json();
    expect(without).toEqual({ session: null });
  });

  it('flags is_admin only for ADMIN_EMAILS', async () => {
    const { call, cookieFrom, signUp } = setup({ ADMIN_EMAILS: 'Boss@Example.com' });
    const cookie = cookieFrom(await signUp('boss@example.com'));
    const body = await (await call('GET', '/api/auth/session', { cookie })).json();
    expect(body.session.user.is_admin).toBe(true);
  });

  it('verifySession (used by the Worker middleware) accepts the real cookie', async () => {
    const { merchant, cookieFrom, signUp } = setup();
    const cookie = cookieFrom(await signUp());
    const session = await verifySession(merchant, cookie);
    expect(session).toMatchObject({ email: 'buyer@example.com', name: 'Buyer' });
    expect(await verifySession(merchant, 'better-auth.session_token=forged.sig')).toBeNull();
  });

  it('signs in with the right password and rejects the wrong one', async () => {
    const { call, signUp } = setup();
    await signUp();

    const bad = await call('POST', '/api/auth/sign-in/email', { body: { email: 'buyer@example.com', password: 'wrong-pass' } });
    expect(bad.status).toBe(401);

    const ok = await call('POST', '/api/auth/sign-in/email', { body: { email: 'buyer@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join('\n')).toContain('better-auth.session_token=');
  });

  it('rejects cookie-bearing requests from an untrusted origin (CSRF)', async () => {
    const { call, cookieFrom, signUp } = setup();
    const cookie = cookieFrom(await signUp());
    const res = await call('POST', '/api/auth/sign-out', { cookie, origin: 'https://evil.example', body: {} });
    expect(res.status).toBe(403);
  });

  it('signs out and invalidates the session', async () => {
    const { merchant, call, cookieFrom, signUp } = setup();
    const cookie = cookieFrom(await signUp());
    expect((await call('POST', '/api/auth/sign-out', { cookie, body: {} })).status).toBe(200);
    // Bypass the 5-minute cookie cache by sending only the session token.
    const tokenOnly = cookie.split('; ').filter((c) => c.startsWith('better-auth.session_token=')).join('; ');
    expect(await verifySession(merchant, tokenOnly)).toBeNull();
  });

  it('uses Lax cookies on http and SameSite=None; Secure on https', async () => {
    const local = setup();
    expect((await local.signUp()).headers.getSetCookie().join('\n')).toContain('SameSite=Lax');

    const prod = setup({ API_BASE_URL: 'https://api.shop.example' });
    const res = await prod.merchant.fetch(
      new Request('https://api.shop.example/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: STORE, 'cf-connecting-ip': '10.0.1.1' },
        body: JSON.stringify({ name: 'P', email: 'p@example.com', password: 'password123' }),
      })
    );
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
  });
});

describe('allowedOrigins', () => {
  it('parses CORS_ORIGIN, trims trailing slashes, falls back to STORE_URL', () => {
    expect(allowedOrigins({ CORS_ORIGIN: 'http://localhost:5173/, https://shop.example ' })).toEqual([
      'http://localhost:5173',
      'https://shop.example',
    ]);
    expect(allowedOrigins({ STORE_URL: 'https://shop.example' })).toEqual(['https://shop.example']);
    expect(allowedOrigins({})).toEqual([]);
  });
});
