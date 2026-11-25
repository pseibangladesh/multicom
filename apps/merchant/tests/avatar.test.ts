/**
 * Customer profile pictures: POST/DELETE /v1/me/avatar and the `image` field
 * of GET /v1/me/profile, on the real Worker and schema with an in-memory R2.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { hashKey } from '../src/middleware/auth';
import { ownedAvatarKey, sniffImageType } from '../src/lib/avatar';

vi.mock('../src/middleware/rate-limit', () => ({
  rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
const purged: string[] = [];
vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {}, delete: async (r: Request) => void purged.push(r.url) } });
const { default: worker } = await import('../src/index');

const API = 'https://api.shop.test';
const PK = 'pk_' + 'd'.repeat(48);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Sql = (q: string, ...a: unknown[]) => { toArray: () => Record<string, unknown>[] };
let sql: Sql;
const bucket = new Map<string, { bytes: Uint8Array; type?: string }>();
let env: Record<string, unknown>;

async function call(who: 'alice' | 'bob', method: string, path: string, body?: FormData) {
  const res = await worker.fetch(
    new Request(API + path, {
      method,
      headers: { Cookie: `better-auth.session_token=${who}.sig`, Authorization: `Bearer ${PK}`, Origin: 'https://shop.test' },
      body,
    }),
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as { image?: string | null } | null };
}

const form = (bytes: Uint8Array, name: string, type: string) => {
  const f = new FormData();
  f.append('file', new File([bytes], name, { type }));
  return f;
};

beforeAll(async () => {
  const ENV = { API_BASE_URL: API, STORE_URL: 'https://shop.test', BETTER_AUTH_SECRET: 'x'.repeat(40) };
  const { merchant, ready } = createMerchantDb(ENV);
  await ready();
  const m = merchant as unknown as { sql: { exec: Sql }; getSessionForCookie: (c: string) => Promise<unknown> };
  sql = m.sql.exec.bind(m.sql);
  sql(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k', ?, 'pk_dddd', 'public')`, await hashKey(PK));
  for (const [id, email] of [['u-alice', 'alice@x.test'], ['u-bob', 'bob@x.test']]) {
    sql(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 0)`, id, id, email);
  }
  m.getSessionForCookie = async (cookie: string) => {
    const who = /session_token=(\w+)/.exec(cookie)?.[1];
    return who === 'alice' || who === 'bob'
      ? { userId: `u-${who}`, email: `${who}@x.test`, name: who, emailVerified: true }
      : null;
  };
  env = {
    ...ENV,
    MERCHANT: { idFromName: () => 'id', get: () => merchant },
    KV_CACHE: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
    IMAGES: {
      put: async (key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
        bucket.set(key, { bytes: value, type: opts?.httpMetadata?.contentType });
      },
      delete: async (key: string) => void bucket.delete(key),
      get: async () => null,
    },
  };
});

beforeEach(() => {
  bucket.clear();
  purged.length = 0;
  sql(`UPDATE "user" SET image = NULL`);
});

const imageOf = (id: string) => sql(`SELECT image FROM "user" WHERE id = ?`, id).toArray()[0]?.image;

describe('profile picture upload', () => {
  it('stores a PNG, saves its URL on the account and returns it in the profile', async () => {
    const r = await call('alice', 'POST', '/v1/me/avatar', form(PNG, 'me.png', 'image/png'));
    expect(r.status).toBe(200);
    expect(r.json?.image).toMatch(new RegExp(`^${API}/v1/images/avatar-[0-9a-f-]{36}\\.png$`));
    const key = r.json!.image!.split('/').pop()!;
    expect(bucket.get(key)?.type).toBe('image/png');
    expect(imageOf('u-alice')).toBe(r.json!.image);
    expect(imageOf('u-bob')).toBeNull();

    const profile = await call('alice', 'GET', '/v1/me/profile');
    expect(profile.json?.image).toBe(r.json!.image);
  });

  it('trusts the bytes, not the browser: an SVG named .png is refused', async () => {
    const r = await call('alice', 'POST', '/v1/me/avatar', form(SVG, 'me.png', 'image/png'));
    expect(r.status).toBe(400);
    expect(bucket.size).toBe(0);
    expect(imageOf('u-alice')).toBeNull();
  });

  it('uses the detected type even when the browser says otherwise', async () => {
    const r = await call('alice', 'POST', '/v1/me/avatar', form(JPEG, 'me.png', 'image/png'));
    expect(r.json?.image).toMatch(/\.jpg$/);
    expect([...bucket.values()][0].type).toBe('image/jpeg');
  });

  it('refuses files over 2 MB', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    const r = await call('alice', 'POST', '/v1/me/avatar', form(big, 'big.png', 'image/png'));
    expect(r.status).toBe(400);
    expect(bucket.size).toBe(0);
  });

  it('deletes the old picture when replaced, and on remove', async () => {
    const first = await call('alice', 'POST', '/v1/me/avatar', form(PNG, 'a.png', 'image/png'));
    const second = await call('alice', 'POST', '/v1/me/avatar', form(JPEG, 'b.jpg', 'image/jpeg'));
    expect([...bucket.keys()]).toEqual([second.json!.image!.split('/').pop()]);
    expect(first.json!.image).not.toBe(second.json!.image);

    // The replaced picture is also purged from the edge cache.
    expect(purged).toEqual([first.json!.image]);

    const del = await call('alice', 'DELETE', '/v1/me/avatar');
    expect(del.json).toEqual({ image: null });
    expect(bucket.size).toBe(0);
    expect(purged).toEqual([first.json!.image, second.json!.image]);
    expect(imageOf('u-alice')).toBeNull();
  });

  it('never deletes a picture it did not store (e.g. an external URL)', async () => {
    sql(`UPDATE "user" SET image = 'https://cdn.example.com/avatar-x.png' WHERE id = 'u-alice'`);
    bucket.set('product-photo.png', { bytes: PNG });
    await call('alice', 'DELETE', '/v1/me/avatar');
    expect(bucket.has('product-photo.png')).toBe(true);
    expect(imageOf('u-alice')).toBeNull();
  });

  it('needs a session', async () => {
    const res = await worker.fetch(
      new Request(API + '/v1/me/avatar', { method: 'POST', body: form(PNG, 'a.png', 'image/png'), headers: { Authorization: `Bearer ${PK}` } }),
      env as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(res.status).toBe(401);
    expect(bucket.size).toBe(0);
  });
});

describe('avatar helpers', () => {
  it('recognises JPEG, PNG and WebP only', () => {
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ');
    expect(sniffImageType(PNG)?.ext).toBe('png');
    expect(sniffImageType(JPEG)?.ext).toBe('jpg');
    expect(sniffImageType(webp)?.ext).toBe('webp');
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('GIF89a'))).toBeNull();
  });

  it('only claims keys it created under the images URL', () => {
    const base = `${API}/v1/images`;
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(ownedAvatarKey(`${base}/avatar-${id}.png`, base)).toBe(`avatar-${id}.png`);
    expect(ownedAvatarKey(`${base}/${id}.png`, base)).toBeNull(); // a product image
    expect(ownedAvatarKey(`https://evil.test/v1/images/avatar-${id}.png`, base)).toBeNull();
    expect(ownedAvatarKey(`${base}/avatar-${id}.png/../x`, base)).toBeNull();
    expect(ownedAvatarKey(null, base)).toBeNull();
  });
});
