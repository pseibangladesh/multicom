/**
 * Buy now, page builder and showcase sections (migration 042).
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md
 */
import { describe, it, expect } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createMerchantDb } from './helpers/merchant-db';
import { publicCategories, adminCategories, adminCategoryList } from '../src/routes/categories';
import { adminCatalog } from '../src/routes/catalog';
import { sitemapRouter } from '../src/routes/sitemap';
import { ucp } from '../src/routes/ucp';
import { adminHomeSections, publicHome } from '../src/routes/home-sections';
import { adminCheckout } from '../src/routes/checkout';
import { ApiError, type HonoEnv } from '../src/types';

const SK = 'sk_' + 'a'.repeat(48);
const PK = 'pk_' + 'b'.repeat(48);
const ENV = { MERCHANT_SK: SK, MERCHANT_PK: PK, API_BASE_URL: 'https://api.shop.test', STORE_URL: 'https://shop.test' };

type Row = Record<string, unknown>;
interface SqlHost {
  sql: { exec: (q: string, ...a: unknown[]) => { toArray: () => Row[] } };
  ensureInitialized?: () => Promise<void> | void;
}

export function rows(merchant: unknown, q: string, ...a: unknown[]): Row[] {
  return (merchant as SqlHost).sql.exec(q, ...a).toArray();
}

describe('migration 042', () => {
  it('adds cart source, category visibility and the two built-in sections', async () => {
    const { merchant, ready } = createMerchantDb(ENV);
    await ready();

    rows(merchant, `INSERT INTO carts (id, customer_email, expires_at) VALUES ('c1', 'a@b.test', datetime('now', '+1 day'))`);
    expect(rows(merchant, `SELECT source FROM carts WHERE id = 'c1'`)[0].source).toBe('cart');

    rows(merchant, `INSERT INTO categories (id, handle, name) VALUES ('k1', 'shoes', 'Shoes')`);
    expect(rows(merchant, `SELECT visibility FROM categories WHERE id = 'k1'`)[0].visibility).toBe('listed');

    expect(() => rows(merchant, `UPDATE categories SET visibility = 'secret' WHERE id = 'k1'`)).toThrow();
    expect(() => rows(merchant, `UPDATE carts SET source = 'other' WHERE id = 'c1'`)).toThrow();

    const sections = rows(merchant, `SELECT id, type, sort_order, status FROM home_sections ORDER BY sort_order`);
    expect(sections).toEqual([
      { id: 'builtin-banner', type: 'banner', sort_order: 0, status: 'active' },
      { id: 'builtin-catalogue', type: 'catalogue', sort_order: 100, status: 'active' },
    ]);
  });

  it('seeds only once and cascades when a section category is deleted', async () => {
    const { merchant, ready } = createMerchantDb(ENV);
    await ready();
    await (merchant as SqlHost).ensureInitialized?.();
    expect(rows(merchant, `SELECT COUNT(*) AS n FROM home_sections`)[0].n).toBe(2);

    rows(merchant, `PRAGMA foreign_keys = ON`);
    rows(merchant, `INSERT INTO categories (id, handle, name, visibility) VALUES ('k2', 'offers', 'Offers', 'showcase')`);
    rows(merchant, `INSERT INTO home_sections (id, type, title, category_id, sort_order) VALUES ('s1', 'showcase', 'Offers', 'k2', 50)`);
    expect(rows(merchant, `SELECT product_limit, status FROM home_sections WHERE id = 's1'`)[0]).toEqual({ product_limit: 12, status: 'active' });
    rows(merchant, `DELETE FROM categories WHERE id = 'k2'`);
    expect(rows(merchant, `SELECT id FROM home_sections WHERE id = 's1'`)).toEqual([]);
  });
});

async function setup() {
  const { merchant, ready } = createMerchantDb(ENV);
  await ready();
  const app = new OpenAPIHono<HonoEnv>();
  app.onError((err, c) =>
    c.json({ error: { message: err.message } }, (err instanceof ApiError ? err.statusCode : 500) as 400),
  );
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/', sitemapRouter);
  app.route('/v1/categories', publicCategories);
  app.route('/v1/admin/categories', adminCategoryList);
  app.route('/v1/admin/home-sections', adminHomeSections);
  app.route('/v1/storefront', publicHome);
  app.route('/v1/categories', adminCategories);
  app.route('/v1/products', adminCatalog);
  app.route('/v1/carts', adminCheckout);
  app.route('/', ucp);

  const call = async (method: string, path: string, body?: unknown, key: string | null = SK) => {
    const res = await app.request(
      `https://api.shop.test${path}`,
      {
        method,
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      ENV,
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

/** shoes (listed) + offers (showcase), one active product in both. */
async function seedCategories() {
  const t = await setup();
  const shoes = await t.call('POST', '/v1/categories', { handle: 'shoes', name: 'Shoes' });
  const offers = await t.call('POST', '/v1/categories', { handle: 'offers', name: 'Offers', visibility: 'showcase' });
  expect(shoes.status).toBe(201);
  expect(offers.status).toBe(201);
  expect(offers.json.visibility).toBe('showcase');
  const product = await t.call('POST', '/v1/products', { title: 'Kolhapuri sandal' });
  expect(product.status).toBe(201);
  for (const cat of [shoes, offers]) {
    const r = await t.call('POST', `/v1/categories/${cat.json.id}/products`, { product_ids: [product.json.id] });
    expect(r.status).toBeLessThan(300);
  }
  return { ...t, shoes: shoes.json, offers: offers.json, product: product.json };
}

const handles = (items: { handle: string }[]) => items.map((i) => i.handle).sort();

describe('showcase-only categories', () => {
  it('public category list leaves them out; the admin list has everything', async () => {
    const { call } = await seedCategories();
    expect(handles((await call('GET', '/v1/categories', undefined, null)).json.items)).toEqual(['shoes']);
    expect(handles((await call('GET', '/v1/categories', undefined, PK)).json.items)).toEqual(['shoes']);
    // Same answer for an admin key: public responses are cached and shared.
    expect(handles((await call('GET', '/v1/categories')).json.items)).toEqual(['shoes']);
    const all = await call('GET', '/v1/admin/categories');
    expect(handles(all.json.items)).toEqual(['offers', 'shoes']);
    expect(all.json.items.find((c: { handle: string }) => c.handle === 'offers').visibility).toBe('showcase');
  });

  it('handle routes 404 for showcase-only', async () => {
    const { call } = await seedCategories();
    expect((await call('GET', '/v1/categories/offers', undefined, null)).status).toBe(404);
    expect((await call('GET', '/v1/categories/offers/products', undefined, null)).status).toBe(404);
    expect((await call('GET', '/v1/categories/shoes/products', undefined, null)).status).toBe(200);
  });

  it('product responses leave them out; the admin list by product has them', async () => {
    const { call, product } = await seedCategories();
    const one = await call('GET', `/v1/products/${product.id}`, undefined, PK);
    expect(handles(one.json.categories)).toEqual(['shoes']);
    // The list endpoint returns categories: null today (its query never selects
    // pc.product_id; reported separately). What matters here: never 'offers'.
    const list = await call('GET', '/v1/products', undefined, PK);
    expect(handles(list.json.items[0].categories ?? [])).not.toContain('offers');
    const mine = await call('GET', `/v1/admin/categories?product_id=${product.id}`);
    expect(handles(mine.json.items)).toEqual(['offers', 'shoes']);
  });

  it('admin category list needs an admin key', async () => {
    const { call } = await seedCategories();
    expect((await call('GET', '/v1/admin/categories', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v1/admin/categories', undefined, PK)).status).toBe(403);
  });

  it('sitemap works and lists only listed active categories', async () => {
    const { call, product } = await seedCategories();
    const res = await call('GET', '/sitemap.xml', undefined, null);
    expect(res.status).toBe(200);
    expect(res.json).toContain('category=shoes');
    expect(res.json).not.toContain('category=offers');
    expect(res.json).toContain(`/product/${product.id}`);
  });

  it('UCP category list and search filter leave them out', async () => {
    const { call } = await seedCategories();
    const cats = await call('GET', '/ucp/v1/categories', undefined, null);
    expect(handles(cats.json.categories)).toEqual(['shoes']);
    const search = await call('GET', '/ucp/v1/products?category=offers', undefined, null);
    expect(search.status).toBe(200);
    expect(search.json.products ?? search.json.items ?? []).toEqual([]);
  });

  it('rejects showcase-only with a parent or children, and nesting under one', async () => {
    const { call, shoes, offers } = await seedCategories();
    const child = await call('POST', '/v1/categories', { handle: 'sandals', name: 'Sandals', parent_id: shoes.id });
    expect(child.status).toBe(201);
    // shoes has a child: can't become showcase-only
    expect((await call('PATCH', `/v1/categories/${shoes.id}`, { visibility: 'showcase' })).status).toBe(400);
    // showcase-only with a parent
    expect(
      (await call('POST', '/v1/categories', { handle: 'deals', name: 'Deals', visibility: 'showcase', parent_id: shoes.id })).status,
    ).toBe(400);
    expect((await call('PATCH', `/v1/categories/${offers.id}`, { parent_id: shoes.id })).status).toBe(400);
    // nothing can go under a showcase-only category
    expect((await call('PATCH', `/v1/categories/${child.json.id}`, { parent_id: offers.id })).status).toBe(400);
    // back to listed is fine
    expect((await call('PATCH', `/v1/categories/${offers.id}`, { visibility: 'listed' })).status).toBe(200);
  });
});

type Section = { id: string; type: string; title: string | null; category_id: string | null; sort_order: number; status: string; builtin: boolean; product_count: number; category_visibility: string | null };
const ids = (items: { id: string }[]) => items.map((i) => i.id);

async function product(call: Awaited<ReturnType<typeof setup>>['call'], title: string, categoryId: string, position: number) {
  const p = await call('POST', '/v1/products', { title, status: 'active' });
  expect(p.status).toBe(201);
  const v = await call('POST', `/v1/products/${p.json.id}/variants`, { sku: `SKU-${p.json.id.slice(0, 8)}`, title, price_cents: 1000 });
  expect(v.status).toBe(201);
  const r = await call('POST', `/v1/categories/${categoryId}/products`, { product_ids: [p.json.id] });
  expect(r.status).toBeLessThan(300);
  return p.json.id as string;
}

describe('home sections', () => {
  it('lists built-ins and creates a showcase section after them', async () => {
    const { call, offers } = await seedCategories();
    const list = await call('GET', '/v1/admin/home-sections');
    expect(list.status).toBe(200);
    expect(ids(list.json.items)).toEqual(['builtin-banner', 'builtin-catalogue']);
    expect(list.json.items.every((s: Section) => s.builtin)).toBe(true);

    const created = await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: offers.id, product_limit: 8 });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ type: 'showcase', title: 'Offers', category_id: offers.id, status: 'active', builtin: false, product_count: 1, category_visibility: 'showcase' });
    expect(created.json.sort_order).toBeGreaterThan(100);

    expect((await call('POST', '/v1/admin/home-sections', { title: 'X', category_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await call('POST', '/v1/admin/home-sections', { title: 'X', category_id: offers.id, product_limit: 30 })).status).toBe(400);
    expect((await call('POST', '/v1/admin/home-sections', { title: 'X', category_id: offers.id, product_limit: 3 })).status).toBe(400);
  });

  it('built-ins cannot be deleted or retargeted, but can be hidden', async () => {
    const { call, offers } = await seedCategories();
    expect((await call('DELETE', '/v1/admin/home-sections/builtin-banner')).status).toBe(409);
    expect((await call('PATCH', '/v1/admin/home-sections/builtin-catalogue', { category_id: offers.id })).status).toBe(400);
    const hidden = await call('PATCH', '/v1/admin/home-sections/builtin-catalogue', { status: 'hidden' });
    expect(hidden.status).toBe(200);
    expect(hidden.json.status).toBe('hidden');
    expect((await call('DELETE', '/v1/admin/home-sections/nope')).status).toBe(404);
  });

  it('edits and deletes a showcase section', async () => {
    const { call, offers, shoes } = await seedCategories();
    const s = (await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: offers.id })).json;
    const edited = await call('PATCH', `/v1/admin/home-sections/${s.id}`, { title: '{"en-US":"Deals"}', category_id: shoes.id, product_limit: 4, status: 'hidden' });
    expect(edited.status).toBe(200);
    expect(edited.json).toMatchObject({ title: '{"en-US":"Deals"}', category_id: shoes.id, product_limit: 4, status: 'hidden' });
    expect((await call('DELETE', `/v1/admin/home-sections/${s.id}`)).status).toBe(200);
    expect(ids((await call('GET', '/v1/admin/home-sections')).json.items)).not.toContain(s.id);
    // the category itself is untouched
    expect((await call('GET', `/v1/admin/categories`)).json.items.map((c: { id: string }) => c.id)).toContain(offers.id);
  });

  it('order sets the order of every section', async () => {
    const { call, offers } = await seedCategories();
    const s = (await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: offers.id })).json;
    const order = [s.id, 'builtin-catalogue', 'builtin-banner'];
    const res = await call('PUT', '/v1/admin/home-sections/order', { ids: order });
    expect(res.status).toBe(200);
    expect(ids(res.json.items)).toEqual(order);
    expect(ids((await call('GET', '/v1/admin/home-sections')).json.items)).toEqual(order);
  });

  it('order rejects a stale id list and leaves the order alone', async () => {
    const { call, offers } = await seedCategories();
    const s = (await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: offers.id })).json;
    const before = ids((await call('GET', '/v1/admin/home-sections')).json.items);
    expect((await call('PUT', '/v1/admin/home-sections/order', { ids: ['builtin-catalogue', 'builtin-banner'] })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/home-sections/order', { ids: [s.id, 'builtin-catalogue', 'builtin-banner', 'ghost'] })).status).toBe(400);
    expect((await call('PUT', '/v1/admin/home-sections/order', { ids: [s.id, s.id, 'builtin-banner'] })).status).toBe(400);
    expect(ids((await call('GET', '/v1/admin/home-sections')).json.items)).toEqual(before);
  });

  it('starter creates three hidden sections and showcase categories, once', async () => {
    const { call } = await setup();
    const first = await call('POST', '/v1/admin/home-sections/starter');
    expect(first.status).toBe(200);
    expect(first.json.created).toBe(3);
    const second = await call('POST', '/v1/admin/home-sections/starter');
    expect(second.json.created).toBe(0);
    const showcase = second.json.items.filter((s: Section) => s.type === 'showcase');
    expect(showcase).toHaveLength(3);
    expect(showcase.every((s: Section) => s.status === 'hidden' && s.category_visibility === 'showcase')).toBe(true);
    const cats = (await call('GET', '/v1/admin/categories')).json.items;
    expect(handles(cats)).toEqual(['hot-picks', 'new-collection', 'offers']);
    expect(JSON.parse(cats.find((c: { handle: string }) => c.handle === 'offers').name)['bn-BD']).toBeTruthy();
    // still hidden from shoppers
    expect((await call('GET', '/v1/categories', undefined, null)).json.items).toEqual([]);
  });

  it('public home returns active sections in order, limited, without empty or hidden rows', async () => {
    const { call } = await setup();
    const cat = (await call('POST', '/v1/categories', { handle: 'offers', name: 'Offers', visibility: 'showcase' })).json;
    const empty = (await call('POST', '/v1/categories', { handle: 'empty', name: 'Empty', visibility: 'showcase' })).json;
    for (const n of [1, 2, 3, 4, 5]) await product(call, `P${n}`, cat.id, n);
    const s = (await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: cat.id, product_limit: 4 })).json;
    await call('POST', '/v1/admin/home-sections', { title: 'Empty', category_id: empty.id });
    await call('POST', '/v1/admin/home-sections', { title: 'Hidden', category_id: cat.id, status: 'hidden' });

    const res = await call('GET', '/v1/storefront/home', undefined, null);
    expect(res.status).toBe(200);
    const sections = res.json.sections;
    expect(sections.map((x: Section) => x.type)).toEqual(['banner', 'catalogue', 'showcase']);
    expect(sections[2]).toMatchObject({ id: s.id, title: 'Offers' });
    expect(sections[2].products).toHaveLength(4);
    expect(sections[2].products[0].variants).toBeDefined();
    expect(sections[0].products).toBeUndefined();
  });

  it('public home lists products in their category position order', async () => {
    const t = await setup();
    const cat = (await t.call('POST', '/v1/categories', { handle: 'offers', name: 'Offers', visibility: 'showcase' })).json;
    const a = await product(t.call, 'A', cat.id, 0);
    const b = await product(t.call, 'B', cat.id, 0);
    const c3 = await product(t.call, 'C', cat.id, 0);
    rows(t.merchant, `UPDATE product_categories SET position = CASE product_id WHEN ? THEN 2 WHEN ? THEN 0 WHEN ? THEN 1 END WHERE category_id = ?`, a, b, c3, cat.id);
    await t.call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: cat.id });
    const row = (await t.call('GET', '/v1/storefront/home', undefined, null)).json.sections.find((x: Section) => x.type === 'showcase');
    expect(row.products.map((p: { title: string }) => p.title)).toEqual(['B', 'C', 'A']);
    // drafts are never shown
    rows(t.merchant, `UPDATE products SET status = 'draft' WHERE id = ?`, b);
    const row2 = (await t.call('GET', '/v1/storefront/home', undefined, null)).json.sections.find((x: Section) => x.type === 'showcase');
    expect(row2.products.map((p: { title: string }) => p.title)).toEqual(['C', 'A']);
  });

  it('leaves out products without variants', async () => {
    const t = await setup();
    const cat = (await t.call('POST', '/v1/categories', { handle: 'offers', name: 'Offers', visibility: 'showcase' })).json;
    await product(t.call, 'With', cat.id, 0);
    const bare = await product(t.call, 'Bare', cat.id, 0);
    rows(t.merchant, `DELETE FROM variants WHERE product_id = ?`, bare);
    await t.call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: cat.id });
    const row = (await t.call('GET', '/v1/storefront/home', undefined, null)).json.sections.find((x: Section) => x.type === 'showcase');
    expect(row.products.map((p: { title: string }) => p.title)).toEqual(['With']);
  });

  it('a hidden built-in is left out of the public home', async () => {
    const { call } = await setup();
    await call('PATCH', '/v1/admin/home-sections/builtin-banner', { status: 'hidden' });
    const res = await call('GET', '/v1/storefront/home', undefined, null);
    expect(res.json.sections.map((x: Section) => x.type)).toEqual(['catalogue']);
  });

  it('deleting the category removes its section and the home still renders', async () => {
    const { call, offers } = await seedCategories();
    const s = (await call('POST', '/v1/admin/home-sections', { title: 'Offers', category_id: offers.id })).json;
    expect((await call('DELETE', `/v1/categories/${offers.id}`)).status).toBe(200);
    expect(ids((await call('GET', '/v1/admin/home-sections')).json.items)).not.toContain(s.id);
    const home = await call('GET', '/v1/storefront/home', undefined, null);
    expect(home.status).toBe(200);
    expect(home.json.sections.map((x: Section) => x.type)).toEqual(['banner', 'catalogue']);
  });

  it('admin routes need an admin key', async () => {
    const { call } = await setup();
    expect((await call('GET', '/v1/admin/home-sections', undefined, null)).status).toBe(401);
    expect((await call('GET', '/v1/admin/home-sections', undefined, PK)).status).toBe(403);
    expect((await call('PUT', '/v1/admin/home-sections/order', { ids: [] }, PK)).status).toBe(403);
  });
});

describe('cart source', () => {
  it('creates a buy_now cart and returns its source; carts default to cart', async () => {
    const { call, merchant } = await setup();
    const bn = await call('POST', '/v1/carts', { customer_email: 'a@b.test', source: 'buy_now' }, PK);
    expect(bn.status).toBe(200);
    expect(bn.json.source).toBe('buy_now');
    expect(rows(merchant, `SELECT source FROM carts WHERE id = ?`, bn.json.id)[0].source).toBe('buy_now');
    const plain = await call('POST', '/v1/carts', { customer_email: 'a@b.test' }, PK);
    expect(plain.json.source).toBe('cart');
    expect((await call('POST', '/v1/carts', { customer_email: 'a@b.test', source: 'other' }, PK)).status).toBe(400);
  });
});

describe('GET /v1/storefront/best-sellers', () => {
  it('ranks active products by units sold in paid-onward orders', async () => {
    const { merchant, call } = await setup();
    const sql = (q: string) => rows(merchant, q);
    sql(`INSERT INTO products (id, title, status) VALUES ('pa', 'A', 'active'), ('pb', 'B', 'active'), ('pc', 'C', 'active'), ('pd', 'Draft', 'draft')`);
    sql(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES
      ('va1', 'pa', 'A-1', 'A1', 100), ('va2', 'pa', 'A-2', 'A2', 100),
      ('vb', 'pb', 'B-1', 'B1', 100), ('vc', 'pc', 'C-1', 'C1', 100), ('vd', 'pd', 'D-1', 'D1', 100)`);
    const order = (id: string, status: string) =>
      sql(`INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents)
           VALUES ('${id}', '${id}', '${status}', 'x@y.test', 0, 0, 0)`);
    order('o1', 'paid');
    order('o2', 'delivered');
    order('o3', 'canceled');
    const item = (id: string, o: string, sku: string, qty: number) =>
      sql(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES ('${id}', '${o}', '${sku}', 't', ${qty}, 100)`);
    item('i1', 'o1', 'A-1', 2);
    item('i2', 'o2', 'A-2', 2); // A: 4 across two variants
    item('i3', 'o1', 'B-1', 3); // B: 3
    item('i4', 'o3', 'C-1', 50); // canceled: ignored
    item('i5', 'o1', 'D-1', 99); // draft product: ignored

    const res = await call('GET', '/v1/storefront/best-sellers', undefined, null);
    expect(res.status).toBe(200);
    expect(res.json.items.map((p: { id: string }) => p.id)).toEqual(['pa', 'pb']);

    const one = await call('GET', '/v1/storefront/best-sellers?limit=1', undefined, null);
    expect(one.json.items.map((p: { id: string }) => p.id)).toEqual(['pa']);
  });
});

describe('GET /v1/products/pricing-audit', () => {
  it('reaches the audit (not GET /{id}) and lists variants with no price in the currency', async () => {
    const { merchant, call } = await setup();
    const [cur, prod, v1, v2] = Array.from({ length: 4 }, () => crypto.randomUUID());
    rows(merchant, `INSERT INTO currencies (id, code, display_name) VALUES (?, 'BDT', 'Taka')`, cur);
    rows(merchant, `INSERT INTO products (id, title, status) VALUES (?, 'Sari', 'active')`, prod);
    rows(merchant, `INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES (?, ?, 'S-1', 'Red', 100), (?, ?, 'S-2', 'Blue', 100)`, v1, prod, v2, prod);
    rows(merchant, `INSERT INTO variant_prices (id, variant_id, currency_id, price_cents) VALUES ('vp1', ?, ?, 9900)`, v1, cur);

    const res = await call('GET', `/v1/products/pricing-audit?currencyId=${cur}`);
    expect(res.status).toBe(200);
    expect(res.json.currencyCode).toBe('BDT');
    expect(res.json.missing.map((m: { variantSku: string }) => m.variantSku)).toEqual(['S-2']);

    // Still admin-only.
    expect((await call('GET', `/v1/products/pricing-audit?currencyId=${cur}`, undefined, PK)).status).toBe(403);
  });
});
