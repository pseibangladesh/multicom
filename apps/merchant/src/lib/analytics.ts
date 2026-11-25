/**
 * Chart data for the admin dashboard and analytics page
 * (GET /v1/analytics/dashboard).
 *
 * - Orders and revenue over time, with empty days filled in so a chart's x-axis
 *   has no gaps. "all" is bucketed by month.
 * - Units sold per top-level category (the root of each product's category
 *   tree, so a product in "Jute Goods > Bags" counts once, under Jute Goods).
 * - Orders per source: the storefront, or the marketplace channel an order was
 *   imported from (Etsy / eBay / Amazon). There is no visitor tracking, so this
 *   is the honest "where sales come from" measure.
 *
 * Revenue counts paid-or-later orders only (same rule as the revenue cards).
 * Amounts are summed across currencies, as the existing cards do; `currencies`
 * lists what was summed so the UI can say so.
 */
import type { Database } from '../db';

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all';

export const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered'] as const;
const IN_PAID = `(${PAID_STATUSES.map((s) => `'${s}'`).join(', ')})`;

export interface TimePoint {
  /** YYYY-MM-DD, or YYYY-MM when bucketed by month. */
  date: string;
  /** Orders placed (any status except canceled). */
  orders: number;
  /** Revenue from paid-or-later orders, in minor units. */
  revenue_cents: number;
}

export interface CategorySlice {
  category_id: string;
  /** Plain text or per-locale JSON, as stored. */
  name: string;
  units_sold: number;
  revenue_cents: number;
}

export interface SourceSlice {
  /** 'storefront' | 'etsy' | 'ebay' | 'amazon' */
  source: string;
  orders: number;
  revenue_cents: number;
}

export function periodDays(period: AnalyticsPeriod): number | null {
  return period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : null;
}

/** SQL lower bound for created_at. Built from the validated enum only. */
export function sinceExpr(period: AnalyticsPeriod): string {
  const days = periodDays(period);
  // created_at holds both "YYYY-MM-DD HH:MM:SS" and ISO strings; comparing the
  // first 10 characters (the date) works for both.
  return days ? `date('now', '-${days - 1} days')` : `'0000-00-00'`;
}

/** Every day from `days - 1` days ago to `today`, as YYYY-MM-DD (UTC). */
export function dayRange(days: number, today = new Date()): string[] {
  const out: string[] = [];
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Orders and revenue per day (per month for "all"), gaps filled with zeros. */
export async function ordersOverTime(db: Database, period: AnalyticsPeriod, today = new Date()): Promise<TimePoint[]> {
  const days = periodDays(period);
  const bucket = days ? 'substr(created_at, 1, 10)' : 'substr(created_at, 1, 7)';
  const rows = await db.query<{ bucket: string; orders: number; revenue_cents: number }>(
    `SELECT ${bucket} AS bucket,
            COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status IN ${IN_PAID} THEN total_cents ELSE 0 END), 0) AS revenue_cents
       FROM orders
      WHERE status != 'canceled' AND substr(created_at, 1, 10) >= ${sinceExpr(period)}
      GROUP BY bucket
      ORDER BY bucket`,
  );
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const keys = days ? dayRange(days, today) : rows.map((r) => r.bucket);
  return keys.map((date) => ({
    date,
    orders: Number(byBucket.get(date)?.orders ?? 0),
    revenue_cents: Number(byBucket.get(date)?.revenue_cents ?? 0),
  }));
}

/** Units sold per top-level category, most first. Uncategorised sales are left out. */
export async function salesByCategory(db: Database, period: AnalyticsPeriod): Promise<CategorySlice[]> {
  const sold = await db.query<{ product_id: string; units: number; revenue_cents: number }>(
    `SELECT v.product_id AS product_id,
            SUM(oi.qty) AS units,
            SUM(oi.qty * oi.unit_price_cents) AS revenue_cents
       FROM order_items oi
       JOIN variants v ON v.sku = oi.sku
       JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ${IN_PAID} AND substr(o.created_at, 1, 10) >= ${sinceExpr(period)}
      GROUP BY v.product_id`,
  );
  if (sold.length === 0) return [];

  const cats = await db.query<{ id: string; parent_id: string | null; name: string }>(
    `SELECT id, parent_id, name FROM categories`,
  );
  const byId = new Map(cats.map((c) => [c.id, c]));
  const rootOf = (id: string): string => {
    let cur = byId.get(id);
    for (let hops = 0; cur?.parent_id && byId.has(cur.parent_id) && hops < 20; hops++) {
      cur = byId.get(cur.parent_id);
    }
    return cur?.id ?? id;
  };

  const links = await db.query<{ product_id: string; category_id: string }>(
    `SELECT product_id, category_id FROM product_categories`,
  );
  const rootsByProduct = new Map<string, Set<string>>();
  for (const l of links) {
    if (!byId.has(l.category_id)) continue;
    const set = rootsByProduct.get(l.product_id) ?? new Set<string>();
    set.add(rootOf(l.category_id));
    rootsByProduct.set(l.product_id, set);
  }

  const totals = new Map<string, { units: number; revenue: number }>();
  for (const s of sold) {
    const roots = [...(rootsByProduct.get(s.product_id) ?? [])].sort();
    if (roots.length === 0) continue;
    // A product filed under two separate trees counts under the first, so the
    // slices add up to the units actually sold.
    const t = totals.get(roots[0]) ?? { units: 0, revenue: 0 };
    t.units += Number(s.units);
    t.revenue += Number(s.revenue_cents);
    totals.set(roots[0], t);
  }

  return [...totals.entries()]
    .map(([id, t]) => ({
      category_id: id,
      name: byId.get(id)?.name ?? id,
      units_sold: t.units,
      revenue_cents: t.revenue,
    }))
    .sort((a, b) => b.units_sold - a.units_sold);
}

/** Orders per source (storefront or marketplace), most first. */
export async function ordersBySource(db: Database, period: AnalyticsPeriod): Promise<SourceSlice[]> {
  const rows = await db.query<{ source: string; orders: number; revenue_cents: number }>(
    `SELECT COALESCE(mc.platform, 'storefront') AS source,
            COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN o.status IN ${IN_PAID} THEN o.total_cents ELSE 0 END), 0) AS revenue_cents
       FROM orders o
       LEFT JOIN marketplace_channels mc ON mc.id = o.channel_id
      WHERE o.status != 'canceled' AND substr(o.created_at, 1, 10) >= ${sinceExpr(period)}
      GROUP BY source
      ORDER BY orders DESC`,
  );
  return rows.map((r) => ({ source: r.source, orders: Number(r.orders), revenue_cents: Number(r.revenue_cents) }));
}

/** Currencies of the paid orders in the period (more than one means mixed sums). */
export async function currenciesInPeriod(db: Database, period: AnalyticsPeriod): Promise<string[]> {
  const rows = await db.query<{ currency: string }>(
    `SELECT DISTINCT currency FROM orders
      WHERE status IN ${IN_PAID} AND substr(created_at, 1, 10) >= ${sinceExpr(period)}
      ORDER BY currency`,
  );
  return rows.map((r) => r.currency);
}
