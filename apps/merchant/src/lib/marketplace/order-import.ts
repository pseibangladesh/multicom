/**
 * Marketplace order import: pulls orders from a channel's client and writes
 * them as internal orders.
 *
 * Per order:
 *   1. Skip cancelled and not-yet-paid orders (unpaid ones are retried on a
 *      later run, since nothing is recorded for them).
 *   2. Claim (channel_id, external_order_id) in marketplace_orders. The unique
 *      index makes the import idempotent and safe against concurrent runs.
 *   3. Create/merge the customer by email (placeholder for masked emails),
 *      then the order (orders.channel_id set), order_items and
 *      marketplace_order_lines.
 *   4. Deduct stock from the shared pool: reserve + commitSale, so on_hand
 *      drops and other carts' reservations are left alone.
 *
 * If step 3 fails, the order rows and the claim are removed, so the next run
 * retries. Stock is touched last and per line. The marketplace sale already
 * happened, so a stock problem never undoes the order: when stock is short,
 * what is available is deducted and the shortfall is reported (oversold).
 */
import type { Database } from '../../db';
import { uuid } from '../../types';
import { commitSale, getAvailableQty, reserveInventory } from '../inventory';
import { resolveBuyerEmail } from './buyer';
import type { IMarketplaceClient, MarketOrder } from './types';

/** Payment states that mean the buyer has paid. */
const PAID_STATES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

export interface OrderImportResult {
  fetched: number;
  imported: Array<{ externalOrderId: string; orderId: string; number: string }>;
  skipped: Array<{ externalOrderId: string; reason: 'already_imported' | 'cancelled' | 'unpaid' }>;
  failed: Array<{ externalOrderId: string; error: string }>;
  /** Lines where less stock was deducted than was sold. */
  shortfalls: Array<{ externalOrderId: string; sku: string; ordered: number; deducted: number; error?: string }>;
  /** Marketplace SKUs that match no variant (imported, no stock deducted). */
  unmatchedSkus: Array<{ externalOrderId: string; sku: string }>;
}

/** "2026-11-20T08:00:00.000Z" → "2026-11-20 08:00:00", the format the other timestamps use. */
function sqliteDate(iso: string): string {
  const d = new Date(iso);
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 19).replace('T', ' ');
}

export function internalOrderStatus(order: MarketOrder): 'paid' | 'shipped' {
  return order.status === 'FULFILLED' ? 'shipped' : 'paid';
}

export function orderNumberFor(order: MarketOrder): string {
  return `${order.platform.toUpperCase()}-${order.externalOrderId}`;
}

interface ResolvedLine {
  marketSku: string;
  sku: string;
  /** Matched variant; null when the SKU is unknown here. */
  variantType: string | null;
  title: string;
  qty: number;
  unitPriceCents: number;
  externalLineItemId: string;
}

async function resolveLines(db: Database, channelId: string, order: MarketOrder): Promise<ResolvedLine[]> {
  const lines: ResolvedLine[] = [];
  for (const [i, item] of order.items.entries()) {
    // An explicit mapping wins; otherwise the marketplace SKU is our SKU (that's how we push).
    const [mapped] = await db.query<{ sku: string; variant_type: string | null }>(
      `SELECT v.sku, v.variant_type FROM marketplace_product_mappings m
       JOIN variants v ON v.id = m.variant_id
       WHERE m.channel_id = ? AND m.external_sku = ? LIMIT 1`,
      [channelId, item.sku],
    );
    const [direct] = mapped
      ? [mapped]
      : await db.query<{ sku: string; variant_type: string | null }>(`SELECT sku, variant_type FROM variants WHERE sku = ?`, [item.sku]);

    lines.push({
      marketSku: item.sku,
      sku: direct?.sku ?? item.sku,
      variantType: direct ? (direct.variant_type ?? 'physical') : null,
      title: item.title || item.sku || 'Marketplace item',
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
      externalLineItemId: item.externalLineItemId ?? `line-${i}`,
    });
  }
  return lines;
}

async function ensureCustomer(db: Database, email: string, name: string | undefined, phone: string | undefined): Promise<string> {
  await db.run(
    `INSERT INTO customers (id, email, name, phone, metadata) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(customers.name, excluded.name),
       phone = COALESCE(customers.phone, excluded.phone)`,
    [uuid(), email, name || null, phone || null, JSON.stringify({ source: 'marketplace' })],
  );
  const [row] = await db.query<{ id: string }>(`SELECT id FROM customers WHERE email = ?`, [email]);
  return row.id;
}

/** Deducts up to `qty` without touching other reservations. Returns units deducted. */
async function deductStock(db: Database, sku: string, qty: number): Promise<number> {
  const available = Math.max(0, await getAvailableQty(db, sku));
  const take = Math.min(qty, available);
  if (take <= 0) return 0;
  await reserveInventory(db, sku, take);
  await commitSale(db, sku, take);
  await db.run(`INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`, [uuid(), sku, -take]);
  return take;
}

async function importOne(db: Database, channelId: string, order: MarketOrder, result: OrderImportResult): Promise<void> {
  const ext = order.externalOrderId;
  if (order.cancelled) return void result.skipped.push({ externalOrderId: ext, reason: 'cancelled' });
  if (order.paymentStatus && !PAID_STATES.has(order.paymentStatus)) {
    return void result.skipped.push({ externalOrderId: ext, reason: 'unpaid' });
  }

  const claimId = uuid();
  const claim = await db.run(
    `INSERT INTO marketplace_orders (id, channel_id, external_order_id, status, raw_payload)
     VALUES (?, ?, ?, 'importing', ?)
     ON CONFLICT(channel_id, external_order_id) DO NOTHING`,
    [claimId, channelId, ext, JSON.stringify(order)],
  );
  if (claim.changes === 0) return void result.skipped.push({ externalOrderId: ext, reason: 'already_imported' });

  const orderId = uuid();
  const number = orderNumberFor(order);
  let lines: ResolvedLine[];
  const lineIds: string[] = [];

  try {
    lines = await resolveLines(db, channelId, order);
    const email = resolveBuyerEmail(order.customerEmail, ext);
    const addr = order.shippingAddress;
    const customerId = await ensureCustomer(db, email, addr?.name, addr?.phone);

    await db.run(
      `INSERT INTO orders (id, customer_id, number, status, customer_email, shipping_name, shipping_phone, ship_to,
         subtotal_cents, tax_cents, shipping_cents, total_cents, currency, channel_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        customerId,
        number,
        internalOrderStatus(order),
        email,
        addr?.name || null,
        addr?.phone || null,
        // Same shape the Stripe webhook stores.
        addr
          ? JSON.stringify({
              line1: addr.line1,
              line2: addr.line2 ?? null,
              city: addr.city,
              state: addr.state ?? null,
              postal_code: addr.postalCode,
              country: addr.country,
            })
          : null,
        order.subtotalCents,
        order.taxCents,
        order.shippingCents,
        order.totalCents,
        order.currency,
        channelId,
        sqliteDate(order.createdAt),
      ],
    );

    for (const line of lines) {
      const itemId = uuid();
      await db.run(`INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`, [
        itemId,
        orderId,
        line.sku,
        line.title,
        line.qty,
        line.unitPriceCents,
      ]);
      const lineId = uuid();
      lineIds.push(lineId);
      await db.run(
        `INSERT INTO marketplace_order_lines (id, marketplace_order_id, external_line_item_id, order_item_id, sku, qty)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lineId, claimId, line.externalLineItemId, itemId, line.sku, line.qty],
      );
    }

    await db.run(
      `UPDATE marketplace_orders SET internal_order_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      [orderId, order.status, claimId],
    );
    await db.run(
      `UPDATE customers SET order_count = order_count + 1, total_spent_cents = total_spent_cents + ?,
         last_order_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [order.totalCents, customerId],
    );
  } catch (err) {
    // Undo in FK order so the next run can retry this order from scratch.
    await db.run(`DELETE FROM marketplace_order_lines WHERE marketplace_order_id = ?`, [claimId]).catch(() => {});
    await db.run(`DELETE FROM order_items WHERE order_id = ?`, [orderId]).catch(() => {});
    await db.run(`DELETE FROM marketplace_orders WHERE id = ?`, [claimId]).catch(() => {});
    await db.run(`DELETE FROM orders WHERE id = ?`, [orderId]).catch(() => {});
    result.failed.push({ externalOrderId: ext, error: err instanceof Error ? err.message : String(err) });
    return;
  }

  result.imported.push({ externalOrderId: ext, orderId, number });

  // Stock: shared pool, physical variants only. Errors here are reported, not fatal.
  for (const [i, line] of lines.entries()) {
    if (line.variantType === null) {
      result.unmatchedSkus.push({ externalOrderId: ext, sku: line.marketSku });
      continue;
    }
    if (line.variantType !== 'physical') continue;

    let deducted = 0;
    let error: string | undefined;
    try {
      deducted = await deductStock(db, line.sku, line.qty);
      await db.run(`UPDATE marketplace_order_lines SET inventory_deducted = ? WHERE id = ?`, [deducted, lineIds[i]]);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (deducted < line.qty) {
      result.shortfalls.push({ externalOrderId: ext, sku: line.sku, ordered: line.qty, deducted, ...(error && { error }) });
    }
  }
}

export interface ImportOrdersOptions {
  /** Only orders modified at or after this time. */
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function importOrders(
  db: Database,
  client: Pick<IMarketplaceClient, 'listOrders'>,
  channelId: string,
  opts: ImportOrdersOptions = {},
): Promise<OrderImportResult> {
  const orders = await client.listOrders({ from: opts.from, to: opts.to, limit: opts.limit, by: 'modified' });
  const result: OrderImportResult = { fetched: orders.length, imported: [], skipped: [], failed: [], shortfalls: [], unmatchedSkus: [] };

  // Sequential on purpose: orders for the same SKU must not race for stock.
  for (const order of orders) {
    await importOne(db, channelId, order, result);
  }
  return result;
}
