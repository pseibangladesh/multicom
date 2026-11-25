/**
 * Chart data behind GET /v1/analytics/dashboard (lib/analytics.ts), on the
 * real schema: orders over time with gaps filled, units per top-level
 * category, orders per source.
 */
import { describe, it, expect } from 'vitest';
import { createMerchantDb } from './helpers/merchant-db';
import { getDb } from '../src/db';
import { dayRange, ordersBySource, ordersOverTime, salesByCategory } from '../src/lib/analytics';

async function setup() {
  const { merchant, ready } = createMerchantDb();
  await ready();
  const db = getDb(merchant as never);

  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  // Category tree: Jute (root) > Bags, and Tech (root).
  for (const [id, parent] of [['jute', null], ['bags', 'jute'], ['tech', null]] as const) {
    await db.run(`INSERT INTO categories (id, handle, name, parent_id) VALUES (?, ?, ?, ?)`, [id, id, `{"en-US":"${id}"}`, parent]);
  }
  for (const [pid, sku, cats] of [['p-tote', 'TOTE', ['bags', 'jute']], ['p-case', 'CASE', ['tech']], ['p-none', 'NONE', []]] as const) {
    await db.run(`INSERT INTO products (id, title) VALUES (?, ?)`, [pid, pid]);
    await db.run(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES (?, ?, ?, ?, 100)`, [`v-${pid}`, pid, sku, sku]);
    for (const c of cats) await db.run(`INSERT INTO product_categories (product_id, category_id) VALUES (?, ?)`, [pid, c]);
  }
  await db.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch-etsy', 'etsy', 'default')`);

  let n = 0;
  async function order(status: string, created: string, items: [string, number][], channel: string | null = null) {
    const id = `o${++n}`;
    const total = items.reduce((s, [, q]) => s + q * 100, 0);
    await db.run(
      `INSERT INTO orders (id, number, status, customer_email, subtotal_cents, tax_cents, total_cents, currency, created_at, channel_id)
       VALUES (?, ?, ?, 'a@b.test', ?, 0, ?, 'EUR', ?, ?)`,
      [id, `N${n}`, status, total, total, created, channel],
    );
    for (const [sku, qty] of items) {
      await db.run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, 100)`, [`${id}-${sku}`, id, sku, sku, qty]);
    }
  }
  await order('paid', daysAgo(0), [['TOTE', 2], ['CASE', 1]]);
  await order('delivered', daysAgo(2), [['TOTE', 1]], 'ch-etsy');
  await order('pending', daysAgo(2), [['CASE', 5]]); // counted as an order, not as revenue or units
  await order('canceled', daysAgo(1), [['CASE', 9]]); // ignored everywhere
  await order('paid', daysAgo(1), [['NONE', 4]]); // no category: not in the pie
  await order('paid', daysAgo(40), [['CASE', 3]]); // outside 7d / 30d
  return { db, today };
}

describe('analytics chart data', () => {
  it('fills every day of the period and splits orders from paid revenue', async () => {
    const { db, today } = await setup();
    const week = await ordersOverTime(db, '7d');
    expect(week).toHaveLength(7);
    expect(week.at(-1)).toEqual({ date: today, orders: 1, revenue_cents: 300 });
    const twoDaysAgo = week.at(-3)!;
    expect(twoDaysAgo.orders).toBe(2); // delivered + pending
    expect(twoDaysAgo.revenue_cents).toBe(100); // pending earns nothing yet
    expect(week.at(-2)).toMatchObject({ orders: 1, revenue_cents: 400 }); // canceled left out
    expect(week.at(-4)).toMatchObject({ orders: 0, revenue_cents: 0 });
  });

  it('buckets "all" by month', async () => {
    const { db } = await setup();
    const all = await ordersOverTime(db, 'all');
    expect(all.every((p) => /^\d{4}-\d{2}$/.test(p.date))).toBe(true);
    expect(all.reduce((s, p) => s + p.orders, 0)).toBe(5);
  });

  it('counts units under the top-level category, once per product', async () => {
    const { db } = await setup();
    const slices = await salesByCategory(db, '30d');
    expect(slices.map((s) => [s.category_id, s.units_sold])).toEqual([
      ['jute', 3], // tote is in Bags and Jute: one root, counted once
      ['tech', 1],
    ]);
    expect((await salesByCategory(db, 'all')).find((s) => s.category_id === 'tech')?.units_sold).toBe(4);
  });

  it('splits orders by storefront and marketplace', async () => {
    const { db } = await setup();
    expect(await ordersBySource(db, '30d')).toEqual([
      { source: 'storefront', orders: 3, revenue_cents: 700 },
      { source: 'etsy', orders: 1, revenue_cents: 100 },
    ]);
  });

  it('dayRange ends today and has no gaps', () => {
    const r = dayRange(3, new Date('2026-03-01T12:00:00Z'));
    expect(r).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});
