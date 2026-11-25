/**
 * MIT License
 *
 * Copyright (c) 2026 Ronan Le Meillat - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// apps/merchant/src/routes/analytics.ts
// Aggregated store analytics, all computed server-side with simple SQL.
// No external service needed — Durable Object SQLite is the sole source.
// Admin-only: requires authMiddleware + adminOnly.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { type HonoEnv } from '../types';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import {
  currenciesInPeriod,
  ordersBySource,
  ordersOverTime,
  salesByCategory,
  sinceExpr,
} from '../lib/analytics';

const adminApp = new OpenAPIHono<HonoEnv>();
adminApp.use('*', authMiddleware);

const getDashboardRoute = createRoute({
  method: 'get',
  path: '/dashboard',
  tags: ['Analytics'],
  summary: 'Get store dashboard stats (admin)',
  security: [{ bearerAuth: ['admin:store'] }],
  middleware: [adminOnly] as const,
  request: {
    query: z.object({
      // Validated enum → safe to interpolate as a SQL date expression
      period: z.enum(['7d', '30d', '90d', 'all']).optional().default('30d'),
    }),
  },
  responses: {
    200: {
      description: 'Dashboard statistics',
      content: {
        'application/json': {
          schema: z.object({
            revenue: z.object({
              total_cents:     z.number(),
              order_count:     z.number(),
              avg_order_cents: z.number(),
            }),
            customers: z.object({
              total:     z.number(),
              new:       z.number(),
              returning: z.number(),
            }),
            top_products: z.array(z.object({
              product_id:    z.string(),
              product_title: z.string(),
              units_sold:    z.number(),
              revenue_cents: z.number(),
            })),
            orders_by_status: z.array(z.object({
              status: z.string(),
              count:  z.number(),
            })),
            low_stock_count: z.number(),
            /** Per day (per month for "all"), gaps filled with zeros. */
            orders_over_time: z.array(z.object({
              date:          z.string(),
              orders:        z.number(),
              revenue_cents: z.number(),
            })),
            /** Units sold per top-level category. */
            sales_by_category: z.array(z.object({
              category_id:   z.string(),
              name:          z.string(),
              units_sold:    z.number(),
              revenue_cents: z.number(),
            })),
            /** Orders per source: storefront, etsy, ebay, amazon. */
            orders_by_source: z.array(z.object({
              source:        z.string(),
              orders:        z.number(),
              revenue_cents: z.number(),
            })),
            /** Currencies summed into the revenue figures. */
            currencies: z.array(z.string()),
          }),
        },
      },
    },
  },
});

adminApp.openapi(getDashboardRoute, async (c) => {
  const { period } = c.req.valid('query');
  const db         = getDb(c.var.db);

  // Safe SQL date bound from the Zod-validated enum (no user input). Compared
  // with the date part of created_at, which is stored in two formats.
  const since = sinceExpr(period);

  // ── Revenue (paid + fulfilled orders only) ─────────────────────────────
  const [rev] = await db.query<{
    total_cents:     number;
    order_count:     number;
    avg_order_cents: number;
  }>(
    `SELECT
       COALESCE(SUM(total_cents), 0)  AS total_cents,
       COUNT(*)                        AS order_count,
       COALESCE(AVG(total_cents), 0)  AS avg_order_cents
     FROM orders
     WHERE status IN ('paid','processing','shipped','delivered')
       AND substr(created_at, 1, 10) >= ${since}`
  );

  // ── Customer stats ─────────────────────────────────────────────────────
  // `customers.order_count` is maintained by the existing order flow.
  const [cust] = await db.query<{
    total:              number;
    new_customers:      number;
    returning_customers: number;
  }>(
    `SELECT
       COUNT(*)                                                  AS total,
       SUM(CASE WHEN substr(created_at, 1, 10) >= ${since} THEN 1 ELSE 0 END) AS new_customers,
       SUM(CASE WHEN order_count > 1        THEN 1 ELSE 0 END)  AS returning_customers
     FROM customers`
  );

  // ── Top 10 products by revenue ─────────────────────────────────────────
  // order_items columns: qty (not quantity), unit_price_cents (no total column)
  const topProducts = await db.query<{
    product_id:    string;
    product_title: string;
    units_sold:    number;
    revenue_cents: number;
  }>(
    `SELECT
       p.id                              AS product_id,
       p.title                           AS product_title,
       SUM(oi.qty)                       AS units_sold,
       SUM(oi.qty * oi.unit_price_cents) AS revenue_cents
     FROM order_items oi
     JOIN variants v ON v.sku      = oi.sku
     JOIN products p ON p.id       = v.product_id
     JOIN orders   o ON o.id       = oi.order_id
     WHERE o.status IN ('paid','processing','shipped','delivered')
       AND substr(o.created_at, 1, 10) >= ${since}
     GROUP BY p.id
     ORDER BY revenue_cents DESC
     LIMIT 10`
  );

  // ── Orders by status ───────────────────────────────────────────────────
  const ordersByStatus = await db.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*) AS count FROM orders GROUP BY status`
  );

  // ── Low stock count ────────────────────────────────────────────────────
  // inventory has on_hand + reserved; available = on_hand - reserved (no column)
  const [ls] = await db.query<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM inventory
     WHERE (on_hand - reserved) <= 5 AND (on_hand - reserved) >= 0`
  );

  return c.json(
    {
      revenue: {
        total_cents:     rev.total_cents,
        order_count:     rev.order_count,
        avg_order_cents: Math.round(rev.avg_order_cents),
      },
      customers: {
        total:     cust.total,
        new:       cust.new_customers,
        returning: cust.returning_customers,
      },
      top_products:     topProducts,
      orders_by_status: ordersByStatus,
      low_stock_count:  ls.count,
      orders_over_time:  await ordersOverTime(db, period),
      sales_by_category: await salesByCategory(db, period),
      orders_by_source:  await ordersBySource(db, period),
      currencies:        await currenciesInPeriod(db, period),
    },
    200
  );
});

// ── Cache performance metrics ──────────────────────────────────────────────
const getCacheStatsRoute = createRoute({
  method: 'get',
  path: '/cache-stats',
  tags: ['Analytics'],
  summary: 'Get KV and CDN cache performance metrics (admin)',
  security: [{ bearerAuth: ['admin:store'] }],
  middleware: [adminOnly] as const,
  responses: {
    200: {
      description: 'Cache performance metrics',
      content: {
        'application/json': {
          schema: z.object({
            kv: z.object({
              hits:     z.number().int(),
              misses:   z.number().int(),
              hit_rate: z.number(),
              entries:  z.number().int(),
              search_ttl_seconds: z.number().int(),
              reviews_ttl_seconds: z.number().int(),
              default_ttl_seconds: z.number().int(),
            }),
            cdn: z.object({
              hits:     z.number().int(),
              misses:   z.number().int(),
              hit_rate: z.number(),
            }),
          }),
        },
      },
    },
  },
});

adminApp.openapi(getCacheStatsRoute, async (c) => {
  const kv = c.env.KV_CACHE;

  const [
    kvHits,
    kvMisses,
    cdnHits,
    cdnMisses,
    kvSearchTtlSeconds,
    kvReviewsTtlSeconds,
    kvDefaultTtlSeconds,
  ] = await Promise.all([
    kv.get<number>('stats:kv:hits',    'json').then((v) => v ?? 0),
    kv.get<number>('stats:kv:misses',  'json').then((v) => v ?? 0),
    kv.get<number>('stats:cdn:hits',   'json').then((v) => v ?? 0),
    kv.get<number>('stats:cdn:misses', 'json').then((v) => v ?? 0),
    kv.get<number>('stats:kv:search_ttl_seconds', 'json').then((v) => v ?? 0),
    kv.get<number>('stats:kv:reviews_ttl_seconds', 'json').then((v) => v ?? 0),
    kv.get<number>('stats:kv:default_ttl_seconds', 'json').then((v) => v ?? 0),
  ]);

  // Count currently-cached JSON entries (keys prefixed with 'cache:')
  let entries = 0;
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: 'cache:', ...(cursor ? { cursor } : {}) });
    entries += result.keys.length;
    cursor = result.list_complete ? undefined : (result as any).cursor;
  } while (cursor);

  const kvTotal  = kvHits  + kvMisses;
  const cdnTotal = cdnHits + cdnMisses;

  const searchTtlSeconds =
    kvSearchTtlSeconds ||
    (c.env.KV_CACHE_SEARCH_TTL_SECONDS ? parseInt(c.env.KV_CACHE_SEARCH_TTL_SECONDS) : 300);
  const reviewsTtlSeconds =
    kvReviewsTtlSeconds ||
    (c.env.KV_CACHE_REVIEWS_TTL_SECONDS ? parseInt(c.env.KV_CACHE_REVIEWS_TTL_SECONDS) : 3600);
  const defaultTtlSeconds =
    kvDefaultTtlSeconds ||
    (c.env.KV_CACHE_DEFAULT_TTL_SECONDS ? parseInt(c.env.KV_CACHE_DEFAULT_TTL_SECONDS) : 3600);

  return c.json(
    {
      kv: {
        hits:     kvHits,
        misses:   kvMisses,
        hit_rate: kvTotal  > 0 ? kvHits  / kvTotal  : 0,
        entries,
        search_ttl_seconds: searchTtlSeconds,
        reviews_ttl_seconds: reviewsTtlSeconds,
        default_ttl_seconds: defaultTtlSeconds,
      },
      cdn: {
        hits:     cdnHits,
        misses:   cdnMisses,
        hit_rate: cdnTotal > 0 ? cdnHits / cdnTotal : 0,
      },
    },
    200
  );
});

export { adminApp as adminAnalytics };
