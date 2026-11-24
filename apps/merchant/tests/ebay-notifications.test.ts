/**
 * eBay Notification API receiver: endpoint challenge, X-EBAY-SIGNATURE
 * verification against a real ECDSA key, dedupe, and order-pull fan-out.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { getDb } from '../src/db';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { derToRawSignature, ebayChallengeResponse, parseEbaySignatureHeader } from '../src/lib/marketplace/ebay-notifications';
import { enqueueOrderPulls } from '../src/lib/marketplace/sync-jobs';
import { webhookRoutes } from '../src/routes/marketplace/webhook';
import type { HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

const CRYPTOKEN = 'ebay-notif-crypto-key-0123456789abcdef';
const VERIFICATION_TOKEN = 'verify_token-0123456789abcdefghijklmnop';
const ENV = {
  EBAY_CLIENT_ID: 'app-id',
  EBAY_CLIENT_SECRET: 'app-secret',
  EBAY_RU_NAME: 'ru-name',
  EBAY_VERIFICATION_TOKEN: VERIFICATION_TOKEN,
  API_BASE_URL: 'https://api.shop.test/',
  CRYPTOKEN,
};

function keyPair(namedCurve = 'prime256v1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve });
  // eBay returns the PEM on one line.
  const pem = (publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '');
  return { pem, privateKey };
}

function notification(topic: string, id = 'n-1') {
  return {
    metadata: { topic, schemaVersion: '1.0', deprecated: false },
    notification: { notificationId: id, eventDate: '2026-11-22T10:00:00.000Z', publishDate: '2026-11-22T10:00:01.000Z', publishAttemptCount: 1, data: {} },
  };
}

function sign(privateKey: KeyObject, message: string, kid = 'kid-1', dsaEncoding: 'der' | 'ieee-p1363' = 'der') {
  const signature = createSign('sha1').update(message).sign({ key: privateKey, dsaEncoding }).toString('base64');
  return Buffer.from(JSON.stringify({ alg: 'ecdsa', kid, signature, digest: 'SHA1' })).toString('base64');
}

async function setup(opts: { pem: string; keyStatus?: number } ) {
  const { merchant } = createMerchantDb();
  const db = getDb(merchant as never);
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, status) VALUES
    ('eb1', 'ebay', 'default', 'active'), ('eb2', 'ebay', 'default', 'active'), ('et1', 'etsy', 'default', 'active'), ('eb3', 'ebay', 'default', 'paused')`);
  const creds = new CredentialManager(db, CRYPTOKEN);
  for (const channelId of ['eb1', 'et1', 'eb3']) await creds.saveCredential({ channelId, type: 'oauth_token', value: 't', expiresAt: null });

  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'app-token', expires_in: 7200 });
    if (url.pathname.startsWith('/commerce/notification/v1/public_key/')) {
      return opts.keyStatus && opts.keyStatus !== 200
        ? Response.json({ errors: [{ errorId: 195001 }] }, { status: opts.keyStatus })
        : Response.json({ key: opts.pem, algorithm: 'ECDSA', digest: 'SHA1' });
    }
    return new Response('unexpected', { status: 500 });
  });

  const kvStore = new Map<string, string>();
  const kv = { get: async (k: string) => kvStore.get(k) ?? null, put: async (k: string, v: string) => void kvStore.set(k, v) };
  const sent: unknown[] = [];
  const env = { ...ENV, KV_CACHE: kv, MARKETPLACE_SYNC_QUEUE: { send: async (m: unknown) => void sent.push(m) } };

  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/marketplace/webhook', webhookRoutes({ fetch: fetchMock as unknown as typeof fetch }));

  const post = (body: string, signature?: string, envOverride: Record<string, unknown> = env) =>
    app.request(
      '/v1/marketplace/webhook/ebay',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature && { 'X-EBAY-SIGNATURE': signature }) }, body },
      envOverride,
    );
  const get = (query: string, envOverride: Record<string, unknown> = env) => app.request(`/v1/marketplace/webhook/ebay${query}`, {}, envOverride);
  const jobs = () => merchant.query<{ channel_id: string; job_type: string }>(`SELECT channel_id, job_type FROM marketplace_sync_jobs ORDER BY channel_id`);
  const events = () => merchant.query<{ external_event_id: string; topic: string; processed_at: string | null; error: string | null }>(
    `SELECT external_event_id, topic, processed_at, error FROM marketplace_webhook_events`,
  );
  return { merchant, db, app, post, get, jobs, events, sent, calls, env };
}

describe('eBay endpoint validation (GET ?challenge_code)', () => {
  it('answers sha256(challengeCode + verificationToken + endpoint) as JSON', async () => {
    const { get } = await setup(keyPair());
    const res = await get('?challenge_code=abc123');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const expected = createHash('sha256').update('abc123').update(VERIFICATION_TOKEN).update('https://api.shop.test/v1/marketplace/webhook/ebay').digest('hex');
    expect(await res.json()).toEqual({ challengeResponse: expected });
    expect(await ebayChallengeResponse('abc123', VERIFICATION_TOKEN, 'https://api.shop.test/v1/marketplace/webhook/ebay')).toBe(expected);
  });

  it('uses EBAY_NOTIFICATION_ENDPOINT when set, 400s without a code, 503s when unconfigured or the token is malformed', async () => {
    const { get, env } = await setup(keyPair());
    const custom = 'https://hooks.shop.test/ebay';
    const res = await get('?challenge_code=x', { ...env, EBAY_NOTIFICATION_ENDPOINT: custom });
    expect(((await res.json()) as { challengeResponse: string }).challengeResponse).toBe(
      createHash('sha256').update('x' + VERIFICATION_TOKEN + custom).digest('hex'),
    );
    expect((await get('')).status).toBe(400);
    expect((await get('?challenge_code=x', { ...env, EBAY_VERIFICATION_TOKEN: undefined })).status).toBe(503);
    expect((await get('?challenge_code=x', { ...env, EBAY_VERIFICATION_TOKEN: 'short' })).status).toBe(503);
  });
});

describe('eBay notifications (POST)', () => {
  it('verifies a DER signature, records the event, and queues a pull for each connected active eBay channel', async () => {
    const { pem, privateKey } = keyPair();
    const { post, jobs, events, sent, calls } = await setup({ pem });
    const body = JSON.stringify(notification('ORDER_CONFIRMATION'));

    const res = await post(body, sign(privateKey, body));
    expect(res.status).toBe(204);
    // eb2 has no token, eb3 is paused, et1 is Etsy.
    expect(jobs()).toEqual([{ channel_id: 'eb1', job_type: 'pull_orders' }]);
    expect(sent).toHaveLength(1);
    expect(events()).toEqual([{ external_event_id: 'n-1', topic: 'ORDER_CONFIRMATION', processed_at: expect.any(String), error: null }]);
    expect(calls).toEqual(['/identity/v1/oauth2/token', '/commerce/notification/v1/public_key/kid-1']);
  });

  it('accepts raw r||s signatures and P-384 keys too', async () => {
    const { pem, privateKey } = keyPair('secp384r1');
    const { post } = await setup({ pem });
    const body = JSON.stringify(notification('ITEM_MARKED_SHIPPED'));
    expect((await post(body, sign(privateKey, body, 'kid-1', 'ieee-p1363'))).status).toBe(204);
  });

  it('verifies against JSON.stringify of the body, like eBay’s SDK, even if the raw body is formatted', async () => {
    const { pem, privateKey } = keyPair();
    const { post } = await setup({ pem });
    const n = notification('ORDER_CONFIRMATION');
    const pretty = JSON.stringify(n, null, 2);
    expect((await post(pretty, sign(privateKey, JSON.stringify(n)))).status).toBe(204);
  });

  it('412s on a tampered body, another key, or a missing/garbage header, and records nothing', async () => {
    const { pem, privateKey } = keyPair();
    const other = keyPair();
    const { post, jobs, events } = await setup({ pem });
    const body = JSON.stringify(notification('ORDER_CONFIRMATION'));
    const tampered = JSON.stringify(notification('ORDER_CONFIRMATION', 'n-evil'));

    expect((await post(tampered, sign(privateKey, body))).status).toBe(412);
    expect((await post(body, sign(other.privateKey, body))).status).toBe(412);
    expect((await post(body)).status).toBe(412);
    expect((await post(body, 'not base64 json')).status).toBe(412);
    expect((await post(body, Buffer.from(JSON.stringify({ kid: '../../x', signature: 'AA==' })).toString('base64'))).status).toBe(412);
    expect((await post('not json', sign(privateKey, 'not json'))).status).toBe(412);
    expect(jobs()).toEqual([]);
    expect(events()).toEqual([]);
  });

  it('acks redeliveries without queueing twice, and caches the public key', async () => {
    const { pem, privateKey } = keyPair();
    const { merchant, post, jobs, calls } = await setup({ pem });
    const body = JSON.stringify(notification('ORDER_CONFIRMATION'));
    await post(body, sign(privateKey, body));
    merchant.run(`UPDATE marketplace_sync_jobs SET status = 'completed'`); // so a second pull *could* be queued

    expect((await post(body, sign(privateKey, body))).status).toBe(204);
    expect(jobs()).toHaveLength(1);
    expect(calls.filter((p) => p.includes('public_key'))).toHaveLength(1);
  });

  it('records non-order topics (e.g. MARKETPLACE_ACCOUNT_DELETION) without queueing', async () => {
    const { pem, privateKey } = keyPair();
    const { post, jobs, events } = await setup({ pem });
    const body = JSON.stringify(notification('MARKETPLACE_ACCOUNT_DELETION'));
    expect((await post(body, sign(privateKey, body))).status).toBe(204);
    expect(jobs()).toEqual([]);
    expect(events()[0]).toMatchObject({ topic: 'MARKETPLACE_ACCOUNT_DELETION', processed_at: expect.any(String) });
  });

  it('still acks (and records the error) when the queue is unbound, so eBay does not mark the endpoint down', async () => {
    const { pem, privateKey } = keyPair();
    const { post, events, env } = await setup({ pem });
    const body = JSON.stringify(notification('ORDER_CONFIRMATION'));
    expect((await post(body, sign(privateKey, body), { ...env, MARKETPLACE_SYNC_QUEUE: undefined })).status).toBe(204);
    expect(events()[0].error).toMatch(/eb1: MARKETPLACE_SYNC_QUEUE is not bound/);
  });

  it('503s when the key cannot be fetched or the app is unconfigured, 413s on oversized bodies', async () => {
    const { pem, privateKey } = keyPair();
    const { post, env } = await setup({ pem, keyStatus: 404 });
    const body = JSON.stringify(notification('ORDER_CONFIRMATION'));
    expect((await post(body, sign(privateKey, body))).status).toBe(503);
    expect((await post(body, sign(privateKey, body), { ...env, EBAY_CLIENT_SECRET: undefined })).status).toBe(503);
    expect((await post('x'.repeat(70 * 1024), sign(privateKey, body))).status).toBe(413);
  });

  it('501s for Etsy and Amazon instead of accepting unverified payloads', async () => {
    const { app, env } = await setup(keyPair());
    for (const p of ['etsy', 'amazon']) {
      expect((await app.request(`/v1/marketplace/webhook/${p}`, { method: 'POST', body: '{}' }, env)).status).toBe(501);
    }
  });
});

describe('enqueueOrderPulls', () => {
  it('collapses bursts: a channel with a pull pending is skipped', async () => {
    const { db } = await setup(keyPair());
    const queue = { send: async () => undefined };
    expect(await enqueueOrderPulls(db, queue)).toEqual({ queued: ['eb1', 'et1'], alreadyRunning: [], errors: [] });
    expect(await enqueueOrderPulls(db, queue, { platform: 'ebay' })).toEqual({ queued: [], alreadyRunning: ['eb1'], errors: [] });
  });
});

describe('signature helpers', () => {
  it('converts DER to fixed-width r||s, stripping sign padding and left-padding short integers', () => {
    // r = 0x00 0x80 0x01 (padded), s = 0x05 (short)
    const der = Uint8Array.from([0x30, 0x08, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x01, 0x05]);
    const raw = derToRawSignature(der, 4)!;
    expect([...raw]).toEqual([0, 0, 0x80, 0x01, 0, 0, 0, 0x05]);
    expect(derToRawSignature(Uint8Array.from([0x31, 0x00]), 4)).toBeNull();
    expect(derToRawSignature(Uint8Array.from([0x30, 0x08, 0x02, 0x03, 0x00, 0x80, 0x01, 0x02, 0x01, 0x05, 0x00]), 4)).toBeNull();
  });

  it('rejects headers with path-like key ids', () => {
    const h = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
    expect(parseEbaySignatureHeader(h({ kid: 'abc-1', signature: 'AA==' }))).toMatchObject({ kid: 'abc-1' });
    expect(parseEbaySignatureHeader(h({ kid: 'a/b', signature: 'AA==' }))).toBeNull();
    expect(parseEbaySignatureHeader(h({ kid: 'a', signature: '' }))).toBeNull();
    expect(parseEbaySignatureHeader(undefined)).toBeNull();
  });
});
