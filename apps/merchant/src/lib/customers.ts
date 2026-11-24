/**
 * Customer records: who an order or a signed-in user belongs to, and their
 * order count / money spent.
 *
 * Totals are recalculated from the orders table instead of being bumped by
 * each payment flow, so they stay right when an order is refunded, canceled
 * or placed through a flow that forgot to count it.
 */
import { ApiError, now, uuid } from '../types';
import type { Database } from '../db';

/** Order statuses that count as a purchase. Refunded/canceled/pending do not. */
export const SPEND_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'partially_refunded'] as const;
const IN_SPEND = `(${SPEND_STATUSES.map((s) => `'${s}'`).join(', ')})`;

export interface CustomerRow {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  locale: string | null;
  accepts_marketing: number | null;
  metadata: string | null;
  order_count: number;
  total_spent_cents: number;
  last_order_at: string | null;
  auth_provider_id: string | null;
  [key: string]: unknown;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Recomputes order_count, total_spent_cents (minus refunds) and last_order_at
 * for one customer from their linked orders.
 */
export async function recalcCustomerStats(db: Database, customerId: string): Promise<void> {
  await db.run(
    `UPDATE customers SET
       order_count = (SELECT COUNT(*) FROM orders WHERE customer_id = ?1 AND status IN ${IN_SPEND}),
       total_spent_cents = MAX(0,
         (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE customer_id = ?1 AND status IN ${IN_SPEND})
         - (SELECT COALESCE(SUM(r.amount_cents), 0) FROM refunds r JOIN orders o ON o.id = r.order_id
             WHERE o.customer_id = ?1 AND o.status IN ${IN_SPEND} AND r.status NOT IN ('failed', 'canceled'))),
       last_order_at = (SELECT MAX(created_at) FROM orders WHERE customer_id = ?1 AND status IN ${IN_SPEND}),
       updated_at = ?2
     WHERE id = ?1`,
    [customerId, now()],
  );
}

/**
 * The customer record for an email: found (case-insensitively) or created.
 * Name and phone fill in blanks only; they never overwrite what's there.
 */
export async function upsertCustomerByEmail(
  db: Database,
  email: string,
  details: { name?: string | null; phone?: string | null } = {},
): Promise<string> {
  const addr = normalizeEmail(email);
  const [existing] = await db.query<{ id: string }>(`SELECT id FROM customers WHERE lower(email) = ? LIMIT 1`, [addr]);
  if (existing) {
    await db.run(
      `UPDATE customers SET name = COALESCE(name, ?), phone = COALESCE(phone, ?), updated_at = ? WHERE id = ?`,
      [details.name ?? null, details.phone ?? null, now(), existing.id],
    );
    return existing.id;
  }
  const id = uuid();
  await db.run(
    `INSERT INTO customers (id, email, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, addr, details.name ?? null, details.phone ?? null, now(), now()],
  );
  return id;
}

/**
 * Links an order to its customer (by the order's email) and refreshes that
 * customer's totals. Call after an order is created or its status changes.
 */
export async function linkOrderToCustomer(
  db: Database,
  orderId: string,
  details: { name?: string | null; phone?: string | null } = {},
): Promise<string | null> {
  const [order] = await db.query<{ customer_id: string | null; customer_email: string | null }>(
    `SELECT customer_id, customer_email FROM orders WHERE id = ?`,
    [orderId],
  );
  if (!order) return null;
  let customerId = order.customer_id;
  if (!customerId) {
    if (!order.customer_email) return null;
    customerId = await upsertCustomerByEmail(db, order.customer_email, details);
    await db.run(`UPDATE orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL`, [customerId, orderId]);
  }
  await recalcCustomerStats(db, customerId);
  return customerId;
}

/** Refreshes the totals of the customer an order belongs to (after a refund or status change). */
export async function refreshOrderCustomer(db: Database, orderId: string): Promise<void> {
  const [order] = await db.query<{ customer_id: string | null }>(`SELECT customer_id FROM orders WHERE id = ?`, [orderId]);
  if (order?.customer_id) await recalcCustomerStats(db, order.customer_id);
}

/**
 * The customer record of a signed-in user. Callers are behind
 * customerAuthMiddleware, which only admits verified emails, so the email is
 * proven to be theirs and any guest record or guest orders under it are
 * theirs too: they are claimed here.
 */
export async function resolveCustomer(db: Database, userId: string): Promise<CustomerRow> {
  const [user] = await db.query<{ email: string; name: string | null; email_verified: number }>(
    `SELECT email, name, email_verified FROM "user" WHERE id = ? LIMIT 1`,
    [userId],
  );
  if (!user) throw ApiError.unauthorized('User not found');
  if (!user.email_verified) throw ApiError.forbidden('Please verify your email address first');

  const addr = normalizeEmail(user.email);
  let [customer] = await db.query<CustomerRow>(`SELECT * FROM customers WHERE auth_provider_id = ? LIMIT 1`, [userId]);
  if (!customer) {
    [customer] = await db.query<CustomerRow>(`SELECT * FROM customers WHERE lower(email) = ? LIMIT 1`, [addr]);
    if (customer) {
      await db.run(
        `UPDATE customers SET auth_provider = 'better-auth', auth_provider_id = ?, name = COALESCE(name, ?), updated_at = ? WHERE id = ?`,
        [userId, user.name ?? null, now(), customer.id],
      );
    } else {
      const id = uuid();
      await db.run(
        `INSERT INTO customers (id, email, auth_provider, auth_provider_id, name, locale, order_count, total_spent_cents, created_at, updated_at)
         VALUES (?, ?, 'better-auth', ?, ?, 'en-US', 0, 0, ?, ?)`,
        [id, addr, userId, user.name || null, now(), now()],
      );
    }
    // Guest orders placed with this (now verified) email become theirs.
    const [linked] = await db.query<{ id: string }>(`SELECT id FROM customers WHERE auth_provider_id = ? LIMIT 1`, [userId]);
    await db.run(`UPDATE orders SET customer_id = ? WHERE customer_id IS NULL AND lower(customer_email) = ?`, [linked.id, addr]);
  }

  const [row] = await db.query<CustomerRow>(`SELECT * FROM customers WHERE auth_provider_id = ? LIMIT 1`, [userId]);
  await recalcCustomerStats(db, row.id);
  const [fresh] = await db.query<CustomerRow>(`SELECT * FROM customers WHERE id = ?`, [row.id]);
  return fresh;
}
