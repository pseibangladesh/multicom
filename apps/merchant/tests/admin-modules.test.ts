/**
 * Admin modules (migration 040): banners, API keys, languages, UCP switch,
 * AI status, and variant colour / size / availability.
 */
import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createMerchantDb } from './helpers/merchant-db';
import { publicBanners, adminBanners } from '../src/routes/banners';
import { adminApiKeys } from '../src/routes/api-keys';
import { publicStorefrontSettings, adminStorefrontSettings } from '../src/routes/storefront-settings';
import { adminCatalog } from '../src/routes/catalog';
import { ucp } from '../src/routes/ucp';
import { isSafeLink, saleBlockReason } from '../src/lib/storefront-settings';
import { parseProductImages } from '../src/lib/product-images';
import { ApiError, type HonoEnv } from '../src/types';

const SK = 'sk_' + 'a'.repeat(48);
const PK = 'pk_' + 'b'.repeat(48);

async function setup(extraEnv: Record<string, string> = {}) {
  const env = { MERCHANT_SK: SK, MERCHANT_PK: PK, API_BASE_URL: 'https://api.shop.test', ...extraEnv };
  const { merchant, ready } = createMerchantDb(env);
  await ready();

  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) =>
    c.json({ error: { message: err.message } }, (err instanceof ApiError ? err.statusCode : 500) as 400),
  );
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/banners', publicBanners);
  app.route('/v1/storefront', publicStorefrontSettings);
  app.route('/v1/admin/settings', adminStorefrontSettings);
  app.route('/v1/admin/banners', adminBanners);
  app.route('/v1/admin/api-keys', adminApiKeys);
  app.route('/v1/products', adminCatalog);
  app.route('/', ucp);

  const call = async (method: string, path: string, body?: unknown, key: string | null = SK) => {
    const res = await app.request(
      `https://api.shop.test${path}`,
      {
        method,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test responses vary by route
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  return { merchant, call };
}

describe('banners', () => {
  it('admin creates, edits and deletes; the public list shows only active ones in order', async () => {
    const { call } = await setup();
    const a = await call('POST', '/v1/admin/banners', {
      title: '{"en-US":"Summer sale","bn-BD":"গ্রীষ্মের সেল"}',
      description: 'Up to 30% off',
      image_url: 'https://img.shop.test/a.webp',
      image_alt: 'Beach towels',
      cta_primary_label: 'Shop now',
      cta_primary_href: '/products',
      sort_order: 2,
      status: 'active',
    });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ title: expect.stringContaining('Summer'), status: 'active', cta_secondary_href: null });

    const b = await call('POST', '/v1/admin/banners', { title: 'First', sort_order: 1, status: 'active' });
    const draft = await call('POST', '/v1/admin/banners', { title: 'Hidden draft' });
    expect(draft.json.status).toBe('draft');

    const pub = await call('GET', '/v1/banners', undefined, null);
    expect(pub.status).toBe(200);
    expect(pub.json.items.map((x: { title: string }) => x.title)).toEqual(['First', a.json.title]);

    const all = await call('GET', '/v1/admin/banners');
    expect(all.json.items).toHaveLength(3);

    const edited = await call('PATCH', `/v1/admin/banners/${b.json.id}`, {
      title: 'Renamed',
      cta_secondary_label: 'About us',
      cta_secondary_href: '/pages/about',
      image_url: null,
    });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ title: 'Renamed', cta_secondary_href: '/pages/about', image_url: null });

    expect((await call('DELETE', `/v1/admin/banners/${b.json.id}`)).status).toBe(200);
    expect((await call('DELETE', `/v1/admin/banners/${b.json.id}`)).status).toBe(404);
    expect((await call('GET', '/v1/admin/banners')).json.items).toHaveLength(2);
  });

  it('rejects unsafe links and half-filled buttons', async () => {
    const { call } = await setup();
    for (const href of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'products']) {
      const r = await call('POST', '/v1/admin/banners', { title: 'x', cta_primary_label: 'Go', cta_primary_href: href });
      expect(r.status, href).toBe(400);
    }
    const noLink = await call('POST', '/v1/admin/banners', { title: 'x', cta_primary_label: 'Go' });
    expect(noLink.status).toBe(400);
    const ok = await call('POST', '/v1/admin/banners', { title: 'x', cta_primary_label: 'Go', cta_primary_href: 'https://etsy.com/shop/x' });
    expect(ok.status).toBe(201);
    // Clearing only the link of an existing button is refused too.
    const half = await call('PATCH', `/v1/admin/banners/${ok.json.id}`, { cta_primary_href: null });
    expect(half.status).toBe(400);
  });

  it('admin endpoints need an admin key', async () => {
    const { call } = await setup();
    expect((await call('GET', '/v1/admin/banners', undefined, null)).status).toBe(401);
    expect((await call('POST', '/v1/admin/banners', { title: 'x' }, PK)).status).toBe(403);
  });

  it('isSafeLink', () => {
    expect(isSafeLink('/?category=caps')).toBe(true);
    expect(isSafeLink('/\\evil.example')).toBe(false);
    expect(isSafeLink('http://example.com')).toBe(true);
  });
});

describe('API keys', () => {
  it('creates a working key shown once, lists without secrets, and revokes it', async () => {
    const { call } = await setup();
    const created = await call('POST', '/v1/admin/api-keys', { name: 'Zapier', role: 'admin' });
    expect(created.status).toBe(201);
    const key: string = created.json.key;
    expect(key).toMatch(/^sk_[0-9a-f]{48}$/);
    expect(created.json).toMatchObject({ name: 'Zapier', role: 'admin', source: 'admin', key_prefix: key.slice(0, 8) });

    // The new key authenticates.
    expect((await call('GET', '/v1/admin/banners', undefined, key)).status).toBe(200);

    const list = await call('GET', '/v1/admin/api-keys');
    expect(JSON.stringify(list.json)).not.toContain(key);
    expect(list.json.items.filter((k: { source: string }) => k.source === 'environment')).toHaveLength(2);

    expect((await call('DELETE', `/v1/admin/api-keys/${created.json.id}`)).status).toBe(200);
    expect((await call('GET', '/v1/admin/banners', undefined, key)).status).toBe(401);
  });

  it('refuses to revoke the environment keys or the key in use', async () => {
    const { call } = await setup();
    const list = await call('GET', '/v1/admin/api-keys');
    for (const k of list.json.items) {
      expect((await call('DELETE', `/v1/admin/api-keys/${k.id}`)).status).toBe(409);
    }
    const mine = await call('POST', '/v1/admin/api-keys', { name: 'self', role: 'admin' });
    expect((await call('DELETE', `/v1/admin/api-keys/${mine.json.id}`, undefined, mine.json.key)).status).toBe(409);
  });

  it('public keys are pk_ and cannot manage keys', async () => {
    const { call } = await setup();
    const pub = await call('POST', '/v1/admin/api-keys', { name: 'Storefront', role: 'public' });
    expect(pub.json.key).toMatch(/^pk_/);
    expect((await call('GET', '/v1/admin/api-keys', undefined, pub.json.key)).status).toBe(403);
  });
});

describe('languages', () => {
  it('defaults to all languages, saves a subset, and validates the default', async () => {
    const { call } = await setup();
    const initial = await call('GET', '/v1/storefront/settings', undefined, null);
    expect(initial.json.languages).toEqual({
      enabled: ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'ar-SA', 'he-IL', 'bn-BD'],
      default: 'en-US',
    });

    const saved = await call('PUT', '/v1/admin/settings/languages', { enabled: ['bn-BD', 'en-US'], default: 'bn-BD' });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ enabled: ['en-US', 'bn-BD'], default: 'bn-BD' });
    expect((await call('GET', '/v1/storefront/settings', undefined, null)).json.languages.default).toBe('bn-BD');

    expect((await call('PUT', '/v1/admin/settings/languages', { enabled: ['en-US'], default: 'fr-FR' })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/settings/languages', { enabled: [], default: 'en-US' })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/settings/languages', { enabled: ['xx-XX'], default: 'xx-XX' })).status).toBe(400);
  });
});

describe('UCP switch and AI status', () => {
  it('turning UCP off makes discovery and the agent API answer 404', async () => {
    const { call } = await setup();
    expect((await call('GET', '/.well-known/ucp', undefined, null)).status).toBe(200);

    const off = await call('PUT', '/v1/admin/settings/ucp', { enabled: false });
    expect(off.json).toEqual({ enabled: false });
    expect((await call('GET', '/.well-known/ucp', undefined, null)).status).toBe(404);
    expect((await call('GET', '/ucp/v1/products', undefined, null)).status).toBe(404);

    const status = await call('GET', '/v1/admin/settings/ai-agents');
    expect(status.json.ucp).toEqual({ enabled: false, discovery_url: 'https://api.shop.test/.well-known/ucp' });

    await call('PUT', '/v1/admin/settings/ucp', { enabled: true });
    expect((await call('GET', '/.well-known/ucp', undefined, null)).status).toBe(200);
  });

  it('reports the environment AI provider without exposing the key', async () => {
    const secret = 'gsk_' + 'z'.repeat(40);
    const { call } = await setup({ AI_API_KEY: secret, AI_MODEL: 'llama-3.3', AI_API_URL: 'https://api.groq.test/v1' });
    const status = await call('GET', '/v1/admin/settings/ai-agents');
    expect(status.status).toBe(200);
    expect(status.json.ai).toMatchObject({ source: 'environment', providers: [{ models: [{ id: 'llama-3.3' }] }] });
    expect(JSON.stringify(status.json)).not.toContain(secret);
  });

  it('reports no AI when nothing is configured', async () => {
    const { call } = await setup();
    expect((await call('GET', '/v1/admin/settings/ai-agents')).json.ai).toMatchObject({ source: 'none', providers: [] });
  });
});

describe('variant colour, size and availability', () => {
  it('are saved on create and update and returned with the product', async () => {
    const { call } = await setup();
    const product = await call('POST', '/v1/products', { title: 'Tee' });
    expect(product.status).toBe(201);
    const v = await call('POST', `/v1/products/${product.json.id}/variants`, {
      sku: 'TEE-RED-M', title: 'Red / M', price_cents: 1500, color: ' Red ', size: 'M',
    });
    expect(v.status).toBe(201);
    expect(v.json).toMatchObject({ color: 'Red', size: 'M', availability: 'in_stock' });

    const patched = await call('PATCH', `/v1/products/${product.json.id}/variants/${v.json.id}`, {
      availability: 'preorder', size: '', color: null,
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ availability: 'preorder', size: null, color: null });

    const bad = await call('PATCH', `/v1/products/${product.json.id}/variants/${v.json.id}`, { availability: 'maybe' });
    expect(bad.status).toBe(400);

    const got = await call('GET', `/v1/products/${product.json.id}`);
    expect(got.json.variants[0]).toMatchObject({ availability: 'preorder', color: null, size: null });
  });

  it('saleBlockReason: out_of_stock blocks, preorder and in_stock do not', () => {
    expect(saleBlockReason({ status: 'active', availability: 'out_of_stock' })).toBe('out_of_stock');
    expect(saleBlockReason({ status: 'draft', availability: 'in_stock' })).toBe('inactive');
    expect(saleBlockReason({ status: 'active', availability: 'preorder' })).toBeNull();
    expect(saleBlockReason({ status: 'active', availability: null })).toBeNull();
  });
});

describe('product image gallery', () => {
  const A = 'https://api.shop.test/v1/images/a.webp';
  const B = 'https://api.shop.test/v1/images/b.webp';
  const C = 'https://api.shop.test/v1/images/c.webp';

  it('saves several images in order, mirrors the cover to image_url, and reorders/clears them', async () => {
    const { call, merchant } = await setup();
    const created = await call('POST', '/v1/products', {
      title: 'Nakshi kantha',
      images: [{ url: A, alt: '{"en-US":"Front"}' }, { url: B }],
    });
    expect(created.status).toBe(201);
    expect(created.json.image_url).toBe(A);
    expect(created.json.images).toEqual([{ url: A, alt: '{"en-US":"Front"}' }, { url: B, alt: '' }]);
    const id = created.json.id as string;

    const got = await call('GET', `/v1/products/${id}`);
    expect(got.json.images.map((i: { url: string }) => i.url)).toEqual([A, B]);

    // Reorder + add: C becomes the cover.
    const upd = await call('PATCH', `/v1/products/${id}`, { images: [{ url: C }, { url: A }, { url: B }] });
    expect(upd.status).toBe(200);
    expect(upd.json.image_url).toBe(C);
    const row = (merchant as unknown as { sql: { exec: (q: string, ...a: unknown[]) => { toArray: () => Record<string, unknown>[] } } })
      .sql.exec('SELECT image_url FROM products WHERE id = ?', id).toArray()[0];
    expect(row.image_url).toBe(C);

    // Other fields leave the gallery alone.
    const renamed = await call('PATCH', `/v1/products/${id}`, { title: 'Kantha quilt' });
    expect(renamed.json.images).toHaveLength(3);

    // Empty list clears it.
    const cleared = await call('PATCH', `/v1/products/${id}`, { images: [] });
    expect(cleared.json).toMatchObject({ images: [], image_url: null });
  });

  it('noimage=true strips the gallery from listings', async () => {
    const { call } = await setup();
    await call('POST', '/v1/products', { title: 'Jamdani', images: [{ url: A }] });
    const list = await call('GET', '/v1/products?noimage=true');
    expect(list.json.items[0]).toMatchObject({ images: [], image_url: null });
  });

  it('rejects non-http URLs, duplicates and too many images', async () => {
    const { call } = await setup();
    const bad = await call('POST', '/v1/products', { title: 'x', images: [{ url: 'javascript:alert(1)' }] });
    expect(bad.status).toBe(400);
    const data = await call('POST', '/v1/products', { title: 'x', images: [{ url: 'data:image/png;base64,AAAA' }] });
    expect(data.status).toBe(400);
    const dup = await call('POST', '/v1/products', { title: 'x', images: [{ url: A }, { url: A }] });
    expect(dup.status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ url: `https://api.shop.test/v1/images/${i}.webp` }));
    expect((await call('POST', '/v1/products', { title: 'x', images: many })).status).toBe(400);
  });

  it('reads pre-gallery products (image_url only) as a one-image gallery', () => {
    expect(parseProductImages(null, A)).toEqual([{ url: A, alt: '' }]);
    expect(parseProductImages('not json', A)).toEqual([{ url: A, alt: '' }]);
    expect(parseProductImages('[{"url":"' + B + '"},{"nope":1}]', A)).toEqual([{ url: B, alt: '' }]);
    expect(parseProductImages(null, null)).toEqual([]);
  });
});
