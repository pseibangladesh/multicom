/**
 * Full Better Auth flow through the real MerchantDO (real schema + migrations)
 * on node:sqlite: the same path the Worker takes when it forwards /api/auth/*.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { allowedOrigins, verifySession } from '../src/lib/session';

const API = 'http://localhost:8787';
const STORE = 'http://localhost:5173';

let ipCounter = 0;

// Mailgun isn't configured in tests, so lib/auth-email.ts logs each link:
// "[Auth] Mailgun is not configured; verify-email link for <to>: <url>".
let mailLog: string[] = [];
beforeEach(() => {
  mailLog = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void mailLog.push(args.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());

/** The latest emailed link of this kind for this address. */
function emailedLink(kind: 'verify-email' | 'reset-password', to: string): string {
  const line = [...mailLog].reverse().find((l) => l.includes(`${kind} link for ${to}:`));
  if (!line) throw new Error(`no ${kind} email for ${to}`);
  return line.slice(line.lastIndexOf(': ') + 2);
}

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

  /** Sign up, then open the emailed link: verified and signed in (its cookie). */
  const signUpVerified = async (email = 'buyer@example.com', password = 'password123') => {
    expect((await signUp(email, password)).status).toBe(200);
    const link = new URL(emailedLink('verify-email', email));
    return merchant.fetch(
      new Request(link.toString(), { headers: { origin: STORE, 'cf-connecting-ip': ip } }),
    );
  };

  return { merchant, call, cookieFrom, signUp, signUpVerified };
}

describe('Better Auth inside MerchantDO', () => {
  it('sign-up emails a verification link and does not sign in yet', async () => {
    const { signUp } = setup();
    const res = await signUp();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join('\n')).not.toContain('better-auth.session_token=');
    expect(emailedLink('verify-email', 'buyer@example.com')).toMatch(/^http:\/\/localhost:8787\/api\/auth\/verify-email\?token=/);
  });

  it('opening the link verifies the email and returns a signed HttpOnly session cookie', async () => {
    const { merchant, signUpVerified } = setup();
    const res = await signUpVerified();
    expect(res.status).toBeLessThan(400);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/better-auth\.session_token=[^;]+\.[^;]+;/); // token.signature
    expect(setCookie).toContain('HttpOnly');
    expect(merchant.query(`SELECT email_verified FROM user`)).toEqual([{ email_verified: 1 }]);
  });

  it('refuses sign-in until the email is verified, and re-sends the link', async () => {
    const { call, signUp } = setup();
    await signUp();
    mailLog = [];
    const res = await call('POST', '/api/auth/sign-in/email', { body: { email: 'buyer@example.com', password: 'password123' } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.headers.getSetCookie().join('\n')).not.toContain('better-auth.session_token=');
    expect(emailedLink('verify-email', 'buyer@example.com')).toContain('/api/auth/verify-email?token=');
  });

  it('marks ADMIN_EMAILS accounts verified so turning verification on never locks admins out', async () => {
    const { merchant, call, signUp } = setup();
    await signUp('owner@example.com'); // signed up (unverified) before being listed in ADMIN_EMAILS
    // Redeploy with ADMIN_EMAILS set: same database, Better Auth rebuilt.
    const internals = merchant as unknown as { env: Record<string, string>; auth: unknown };
    internals.env.ADMIN_EMAILS = 'Owner@Example.com';
    internals.auth = null;
    const res = await call('POST', '/api/auth/sign-in/email', { body: { email: 'owner@example.com', password: 'password123' } });
    expect(res.status).toBe(200);
  });

  it('GET /api/auth/session returns the user for the cookie, null without it', async () => {
    const { call, cookieFrom, signUpVerified } = setup();
    const cookie = cookieFrom(await signUpVerified());

    const withCookie = await (await call('GET', '/api/auth/session', { cookie })).json();
    expect(withCookie.session.user).toMatchObject({ email: 'buyer@example.com', name: 'Buyer', is_admin: false });

    const without = await (await call('GET', '/api/auth/session')).json();
    expect(without).toEqual({ session: null });
  });

  it('flags is_admin only for ADMIN_EMAILS (account made by create-admin.ts)', async () => {
    const { merchant, call, cookieFrom } = setup({ ADMIN_EMAILS: 'Boss@Example.com' });
    await merchant.provisionUser({ email: 'boss@example.com', password: 'password123', name: 'Boss', resetPassword: false });
    const login = await call('POST', '/api/auth/sign-in/email', { body: { email: 'boss@example.com', password: 'password123' } });
    expect(login.status).toBe(200);
    const body = await (await call('GET', '/api/auth/session', { cookie: cookieFrom(login) })).json();
    expect(body.session.user.is_admin).toBe(true);
  });

  it('refuses public sign-up for ADMIN_EMAILS addresses (no first-come admin takeover)', async () => {
    const { merchant, signUp } = setup({ ADMIN_EMAILS: 'boss@example.com' });
    const res = await signUp('BOSS@example.com');
    expect(res.status).toBe(403);
    expect(merchant.query(`SELECT 1 FROM user`)).toEqual([]);
    expect((await signUp('customer@example.com')).status).toBe(200); // everyone else still can
  });

  it('verifySession (used by the Worker middleware) accepts the real cookie', async () => {
    const { merchant, cookieFrom, signUpVerified } = setup();
    const cookie = cookieFrom(await signUpVerified());
    const session = await verifySession(merchant, cookie);
    expect(session).toMatchObject({ email: 'buyer@example.com', name: 'Buyer' });
    expect(await verifySession(merchant, 'better-auth.session_token=forged.sig')).toBeNull();
  });

  it('verifySession is not rate limited: every API request checks the session', async () => {
    // Regression: verifySession used to call /api/auth/get-session through
    // Better Auth's HTTP handler with no client IP, so all users shared one
    // 10-per-minute bucket and the 11th authenticated request got a 401.
    const { merchant, signUpVerified, cookieFrom } = setup();
    const cookie = cookieFrom(await signUpVerified());
    const results = [];
    for (let i = 0; i < 25; i++) results.push((await verifySession(merchant, cookie))?.email ?? null);
    expect(results).toEqual(Array(25).fill('buyer@example.com'));
  });

  it('signs in with the right password and rejects the wrong one', async () => {
    const { call, signUpVerified } = setup();
    await signUpVerified();

    const bad = await call('POST', '/api/auth/sign-in/email', { body: { email: 'buyer@example.com', password: 'wrong-pass' } });
    expect(bad.status).toBe(401);

    const ok = await call('POST', '/api/auth/sign-in/email', { body: { email: 'buyer@example.com', password: 'password123' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join('\n')).toContain('better-auth.session_token=');
  });

  it('rejects cookie-bearing requests from an untrusted origin (CSRF)', async () => {
    const { call, cookieFrom, signUpVerified } = setup();
    const cookie = cookieFrom(await signUpVerified());
    const res = await call('POST', '/api/auth/sign-out', { cookie, origin: 'https://evil.example', body: {} });
    expect(res.status).toBe(403);
  });

  it('signs out and invalidates the session', async () => {
    const { merchant, call, cookieFrom, signUpVerified } = setup();
    const cookie = cookieFrom(await signUpVerified());
    expect((await call('POST', '/api/auth/sign-out', { cookie, body: {} })).status).toBe(200);
    // Bypass the 5-minute cookie cache by sending only the session token.
    const tokenOnly = cookie.split('; ').filter((c) => c.startsWith('better-auth.session_token=')).join('; ');
    expect(await verifySession(merchant, tokenOnly)).toBeNull();
  });

  it('uses Lax cookies on http and SameSite=None; Secure on https', async () => {
    const local = setup();
    expect((await local.signUpVerified()).headers.getSetCookie().join('\n')).toContain('SameSite=Lax');

    const prod = setup({ API_BASE_URL: 'https://api.shop.example' });
    await prod.merchant.fetch(
      new Request('https://api.shop.example/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: STORE, 'cf-connecting-ip': '10.0.1.1' },
        body: JSON.stringify({ name: 'P', email: 'p@example.com', password: 'password123' }),
      })
    );
    const res = await prod.merchant.fetch(
      new Request(emailedLink('verify-email', 'p@example.com'), { headers: { origin: STORE, 'cf-connecting-ip': '10.0.1.1' } }),
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
