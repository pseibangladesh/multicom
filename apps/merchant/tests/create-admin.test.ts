/**
 * Admin provisioning (scripts/create-admin.ts → POST /v1/setup/admin-user →
 * MerchantDO.provisionUser) against the real MerchantDO on node:sqlite. The
 * proof that the password is hashed "the Better Auth way" is that Better
 * Auth's own sign-in endpoint accepts it.
 */
import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createMerchantDb } from './helpers/merchant-db';
import { adminSetup } from '../src/routes/setup';
import { ApiError, type HonoEnv } from '../src/types';
import { isSafeTarget, listsEmail, parseArgs } from '../scripts/create-admin';

const API = 'http://localhost:8787';
const STORE = 'http://localhost:5173';
const SK = 'sk_' + 'c'.repeat(48);
let ipCounter = 0;

async function setup(env: Record<string, string> = {}) {
  const ip = `10.9.0.${++ipCounter}`;
  const fullEnv = {
    BETTER_AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
    API_BASE_URL: API,
    CORS_ORIGIN: STORE,
    MERCHANT_SK: SK,
    ...env,
  };
  const { merchant, ready } = createMerchantDb(fullEnv);
  await ready();

  const signIn = (email: string, password: string) =>
    merchant.fetch(
      new Request(`${API}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: STORE, 'cf-connecting-ip': ip },
        body: JSON.stringify({ email, password }),
      })
    );

  // The Worker route, with the DO namespace pointing at this instance.
  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/setup', adminSetup);
  const bindings = { ...fullEnv, MERCHANT: { idFromName: () => 'default', get: () => merchant } };
  const provision = (body: unknown, key = SK) =>
    app.request(`${API}/v1/setup/admin-user`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, bindings);

  return { merchant, signIn, provision };
}

describe('MerchantDO.provisionUser', () => {
  it('creates user + credential account that Better Auth sign-in accepts', async () => {
    const { merchant, signIn } = await setup();
    const r = await merchant.provisionUser({ email: 'Owner@Shop.test', password: 'correct horse 1', name: 'Owner', resetPassword: false });
    expect(r.status).toBe('created');

    const [account] = merchant.query<{ provider_id: string; password: string }>(
      `SELECT provider_id, password FROM account WHERE user_id = ?`, [r.userId]
    );
    expect(account.provider_id).toBe('credential');
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/); // scrypt salt:key, never plaintext

    expect((await signIn('owner@shop.test', 'correct horse 1')).status).toBe(200);
    expect((await signIn('owner@shop.test', 'wrong password')).status).toBe(401);
  });

  it('leaves an existing password alone unless resetPassword is set', async () => {
    const { merchant, signIn } = await setup();
    const input = { email: 'a@shop.test', password: 'first-pass-1', name: 'A', resetPassword: false };
    await merchant.provisionUser(input);

    expect((await merchant.provisionUser({ ...input, password: 'second-pass-2' })).status).toBe('exists');
    expect((await signIn('a@shop.test', 'first-pass-1')).status).toBe(200);

    expect((await merchant.provisionUser({ ...input, password: 'second-pass-2', resetPassword: true })).status).toBe('password_reset');
    expect((await signIn('a@shop.test', 'second-pass-2')).status).toBe(200);
    expect((await signIn('a@shop.test', 'first-pass-1')).status).toBe(401);
    expect(merchant.query(`SELECT 1 FROM user WHERE email = 'a@shop.test'`)).toHaveLength(1);
  });

  it('rejects passwords shorter than Better Auth allows', async () => {
    const { merchant } = await setup();
    await expect(merchant.provisionUser({ email: 'b@shop.test', password: 'short', name: 'B', resetPassword: false })).rejects.toThrow(/Password must be/);
  });
});

describe('POST /v1/setup/admin-user', () => {
  it('needs the admin API key', async () => {
    const { provision } = await setup();
    expect((await provision({ email: 'x@shop.test', password: 'password-123' }, 'sk_' + 'z'.repeat(48))).status).toBe(401);
  });

  it('reports is_admin from ADMIN_EMAILS', async () => {
    const { provision } = await setup({ ADMIN_EMAILS: 'boss@shop.test' });
    const boss = await (await provision({ email: 'Boss@Shop.test', password: 'password-123' })).json();
    expect(boss).toMatchObject({ status: 'created', email: 'boss@shop.test', is_admin: true });
    const other = await (await provision({ email: 'clerk@shop.test', password: 'password-123' })).json();
    expect(other).toMatchObject({ status: 'created', is_admin: false });
  });

  it('validates input', async () => {
    const { provision } = await setup();
    expect((await provision({ email: 'not-an-email', password: 'password-123' })).status).toBe(400);
  });
});

describe('create-admin.ts helpers', () => {
  it('parses email, optional password and flags', () => {
    expect(parseArgs(['Me@Shop.test', 'pw-123456', '--name', 'Me', '--reset-password'])).toEqual({
      email: 'me@shop.test', password: 'pw-123456', name: 'Me', resetPassword: true, remote: false,
    });
    expect(parseArgs(['me@shop.test', '--remote']).password).toBeUndefined();
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['me@shop.test', '--bogus'])).toThrow(/Unknown option/);
  });

  it('accepts --url and refuses plain http to other machines', () => {
    expect(parseArgs(['a@x.test', '--url', 'http://localhost:8799']).url).toBe('http://localhost:8799');
    expect(() => parseArgs(['a@x.test', '--url', 'https://x', '--remote'])).toThrow(/either/);
    expect(isSafeTarget('http://localhost:8787')).toBe(true);
    expect(isSafeTarget('https://api.shop.test')).toBe(true);
    expect(isSafeTarget('http://api.shop.test')).toBe(false);
    expect(isSafeTarget('not a url')).toBe(false);
  });

  it('matches ADMIN_EMAILS the same way the backend does', () => {
    expect(listsEmail(' a@x.test , Boss@X.test', 'boss@x.test')).toBe(true);
    expect(listsEmail('a@x.test', 'b@x.test')).toBe(false);
    expect(listsEmail(undefined, 'a@x.test')).toBe(false);
  });
});
