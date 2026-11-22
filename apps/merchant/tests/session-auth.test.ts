import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { hasSessionCookie, isAdminEmail, verifySession } from '../src/lib/session';
import { authMiddleware, customerAuthMiddleware, hashKey } from '../src/middleware/auth';
import { ApiError, type HonoEnv } from '../src/types';

const COOKIE = 'better-auth.session_token=abc.sig';

function sessionTarget(user: { id: string; email: string; name?: string } | null, fail = false) {
  return {
    getSessionForCookie: vi.fn(async (_cookie: string) => {
      if (fail) throw new Error('DO unavailable');
      return user ? { userId: user.id, email: user.email, name: user.name ?? null } : null;
    }),
  };
}

/** Builds a test app with a fake MerchantDO stub (get-session + SQL). */
function buildApp(opts: {
  middleware: typeof authMiddleware;
  sessionUser?: { id: string; email: string; name?: string } | null;
  apiKeys?: Record<string, string>; // key_hash -> role
  adminEmails?: string;
}) {
  const target = sessionTarget(opts.sessionUser ?? null);
  const stub = {
    getSessionForCookie: target.getSessionForCookie,
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM api_keys')) {
        const role = opts.apiKeys?.[params[0] as string];
        return role ? [{ role }] : [];
      }
      return [];
    },
    run: async () => ({ changes: 0 }),
  };
  const env = {
    MERCHANT: { idFromName: () => 'id', get: () => stub },
    ADMIN_EMAILS: opts.adminEmails,
  };

  const app = new Hono<HonoEnv>();
  app.onError((err, c) =>
    c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 401)
  );
  app.use('*', async (c, next) => {
    // Hono context variables are typed against the real DO stub.
    c.set('db', stub as never);
    await next();
  });
  app.use('*', opts.middleware);
  app.get('/x', (c) => c.json(c.get('auth')));

  return {
    target,
    request: (headers: Record<string, string> = {}) =>
      app.request('/x', { headers }, env as never),
  };
}

describe('hasSessionCookie', () => {
  it('matches plain and __Secure- prefixed cookies', () => {
    expect(hasSessionCookie(COOKIE)).toBe(true);
    expect(hasSessionCookie('a=1; __Secure-better-auth.session_token=x')).toBe(true);
  });
  it('rejects missing or look-alike cookies', () => {
    expect(hasSessionCookie(undefined)).toBe(false);
    expect(hasSessionCookie('foo=1')).toBe(false);
    expect(hasSessionCookie('evilbetter-auth.session_token=x')).toBe(false);
  });
});

describe('isAdminEmail', () => {
  it('matches case-insensitively with whitespace', () => {
    expect(isAdminEmail('Boss@Shop.com', ' ops@shop.com , boss@shop.com')).toBe(true);
  });
  it('denies when unset or not listed', () => {
    expect(isAdminEmail('boss@shop.com', undefined)).toBe(false);
    expect(isAdminEmail('boss@shop.com', '')).toBe(false);
    expect(isAdminEmail('customer@x.com', 'boss@shop.com')).toBe(false);
  });
});

describe('verifySession', () => {
  it('asks the DO over RPC (not the rate-limited HTTP handler) and returns the user', async () => {
    const target = sessionTarget({ id: 'u1', email: 'a@b.com', name: 'A' });
    expect(await verifySession(target, COOKIE)).toEqual({ userId: 'u1', email: 'a@b.com', name: 'A' });
    expect(target.getSessionForCookie).toHaveBeenCalledWith(COOKIE);
  });

  it('does not call the DO without a session cookie', async () => {
    const target = sessionTarget({ id: 'u1', email: 'a@b.com' });
    expect(await verifySession(target, 'foo=1')).toBeNull();
    expect(target.getSessionForCookie).not.toHaveBeenCalled();
  });

  it('returns null for an invalid/expired session', async () => {
    expect(await verifySession(sessionTarget(null), COOKIE)).toBeNull();
  });

  it('propagates DO failures so the middleware can log them', async () => {
    await expect(verifySession(sessionTarget(null, true), COOKIE)).rejects.toThrow('DO unavailable');
  });
});

describe('customerAuthMiddleware', () => {
  it('sets a customer auth context for a valid session', async () => {
    const { request } = buildApp({
      middleware: customerAuthMiddleware,
      sessionUser: { id: 'u1', email: 'c@x.com', name: 'C' },
    });
    const res = await request({ cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'customer', userId: 'u1', email: 'c@x.com' });
  });

  it('returns 401 without a cookie or with an invalid session', async () => {
    expect((await buildApp({ middleware: customerAuthMiddleware }).request()).status).toBe(401);
    const invalid = buildApp({ middleware: customerAuthMiddleware, sessionUser: null });
    expect((await invalid.request({ cookie: COOKIE })).status).toBe(401);
  });
});

describe('authMiddleware', () => {
  it('grants admin to a session whose email is in ADMIN_EMAILS', async () => {
    const { request } = buildApp({
      middleware: authMiddleware,
      sessionUser: { id: 'u1', email: 'boss@shop.com' },
      adminEmails: 'boss@shop.com',
    });
    const res = await request({ cookie: COOKIE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', userId: 'u1' });
  });

  it('does NOT grant admin to a customer session', async () => {
    const { request } = buildApp({
      middleware: authMiddleware,
      sessionUser: { id: 'u2', email: 'customer@x.com' },
      adminEmails: 'boss@shop.com',
    });
    expect((await request({ cookie: COOKIE })).status).toBe(401);
  });

  it('accepts sk_/pk_ keys by SHA-256 hash lookup', async () => {
    const sk = 'sk_test123';
    const pk = 'pk_test456';
    const { request } = buildApp({
      middleware: authMiddleware,
      apiKeys: { [await hashKey(sk)]: 'admin', [await hashKey(pk)]: 'public' },
    });

    const admin = await request({ authorization: `Bearer ${sk}` });
    expect(await admin.json()).toMatchObject({ role: 'admin' });
    const pub = await request({ authorization: `Bearer ${pk}` });
    expect(await pub.json()).toMatchObject({ role: 'public' });
  });

  it('rejects unknown keys and missing credentials', async () => {
    const { request } = buildApp({ middleware: authMiddleware });
    expect((await request({ authorization: 'Bearer sk_nope' })).status).toBe(401);
    expect((await request()).status).toBe(401);
  });
});
