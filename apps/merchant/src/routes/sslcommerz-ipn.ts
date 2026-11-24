// apps/merchant/src/routes/sslcommerz-ipn.ts
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HonoEnv, ApiError, uuid, now } from '../types';
import { getDb, type Database } from '../db';
import { linkOrderToCustomer } from '../lib/customers';
import { dispatchWebhooks } from '../lib/webhooks';
import { commitSale, reserveInventory, releaseReservation } from '../lib/inventory';
import {
  SSLCOMMERZ_CURRENCIES,
  classifyIpnStatus,
  isSupportedCurrency,
  isValidatedPayment,
  toGatewayAmount,
  type SslValidationResponse,
} from '../lib/sslcommerz';
import { SSLCOMMERZ_CONFIG_KEY, decryptSecret, getSslcommerzSettings, readConfigJson } from '../lib/payment-config';

// ─── Helpers ──────────────────────────────────────────────────────────
async function getDecryptedSslPassword(c: { var: HonoEnv['Variables']; env: HonoEnv['Bindings'] }): Promise<string | null> {
  const row = await readConfigJson(getDb(c.var.db), SSLCOMMERZ_CONFIG_KEY);
  if (!row || row.enabled !== true || typeof row.store_password !== 'string' || !row.store_id) return null;
  const cryptoken = c.env.CRYPTOKEN;
  if (!cryptoken) return null;
  try { return await decryptSecret(row.store_password, cryptoken); } catch { return null; }
}

const getSslConfig = (c: { var: HonoEnv['Variables'] }) => getSslcommerzSettings(getDb(c.var.db));

function getSslBaseUrl(sandbox: boolean): string {
  return sandbox ? 'https://sandbox.sslcommerz.com' : 'https://securegw.sslcommerz.com';
}

// ─── Checkout App (mounted at /v1/carts) ─────────────────────────────
export const sslcommerzCheckoutApp = new OpenAPIHono<HonoEnv>();

const sslCheckoutRoute = createRoute({
  method: 'post',
  path: '/{cartId}/checkout/sslcommerz',
  tags: ['Checkout'],
  summary: 'Initiate SSLCommerz checkout',
  request: {
    params: z.object({ cartId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: z.object({}) } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ gateway_url: z.string() }) } }, description: 'Gateway URL' },
    400: { content: { 'application/json': { schema: z.any() } }, description: 'Config or cart error' },
    404: { content: { 'application/json': { schema: z.any() } }, description: 'Cart not found' },
  },
});

sslcommerzCheckoutApp.openapi(sslCheckoutRoute, async (c) => {
  const { cartId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const sslConfig = await getSslConfig(c);
  if (!sslConfig.enabled || !sslConfig.store_id) throw ApiError.invalidRequest('SSLCommerz is not configured.');
  const storePassword = await getDecryptedSslPassword(c);
  if (!storePassword) throw ApiError.invalidRequest('SSLCommerz password is not configured.');

  // Claim the cart atomically so two concurrent checkouts can't both proceed.
  const claimed = await db.run(
    `UPDATE carts SET status = 'checked_out', updated_at = ? WHERE id = ? AND status = 'open'`,
    [now(), cartId]
  );
  if (claimed.changes === 0) {
    const [existing] = await db.query<any>(`SELECT status FROM carts WHERE id = ?`, [cartId]);
    if (!existing) throw ApiError.notFound('Cart not found');
    throw ApiError.conflict('Cart is not open');
  }

  const reserved: { sku: string; qty: number }[] = [];
  let orderId: string | null = null;
  const rollback = async () => {
    for (const r of reserved) await releaseReservation(db, r.sku, r.qty);
    if (orderId) {
      await db.run(`DELETE FROM order_items WHERE order_id = ?`, [orderId]);
      await db.run(`DELETE FROM orders WHERE id = ?`, [orderId]);
    }
    await db.run(
      `UPDATE carts SET status = 'open', stripe_checkout_session_id = NULL, updated_at = ? WHERE id = ?`,
      [now(), cartId]
    );
  };

  try {
    const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
    const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
    if (items.length === 0) throw ApiError.invalidRequest('Cart is empty');

    const currency = String(cart.currency || 'USD').toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw ApiError.invalidRequest(
        `SSLCommerz does not support ${currency}. Supported: ${SSLCOMMERZ_CURRENCIES.join(', ')}`
      );
    }

    // Reserve stock for physical items, same as the Stripe checkout.
    for (const item of items) {
      const [v] = await db.query<any>(`SELECT variant_type FROM variants WHERE sku = ?`, [item.sku]);
      if (!v || v.variant_type === 'physical') {
        await reserveInventory(db, item.sku, item.qty);
        reserved.push({ sku: item.sku, qty: item.qty });
      }
    }

    const subtotalCents = items.reduce((sum: number, item: any) => sum + item.unit_price_cents * item.qty, 0);
    const shippingCents = cart.shipping_cents || 0;
    const discountCents = cart.discount_amount_cents || 0;
    const totalCents = Math.max(subtotalCents - discountCents + shippingCents, 0);

    // Random, unguessable: the IPN is unauthenticated and keyed by tran_id.
    const tranId = `TXN-${uuid()}`;
    const [customer] = await db.query<any>(`SELECT id FROM customers WHERE email = ?`, [cart.customer_email]);

    orderId = uuid();
    await db.run(
      `INSERT INTO orders (id, customer_id, number, status, customer_email, region_id,
       shipping_name, ship_to, subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
       discount_code, discount_id, discount_amount_cents, taxes_json, viewtoken, viewtoken_issued_at,
       locale, sslcommerz_tran_id, payment_gateway)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, 'sslcommerz')`,
      [
        orderId,
        customer?.id ?? null,
        `ORD-${Date.now().toString(36).toUpperCase()}-${uuid().slice(0, 4).toUpperCase()}`,
        cart.customer_email,
        cart.region_id || null,
        cart.shipping_name || null,
        cart.shipping_line1
          ? JSON.stringify({
              line1: cart.shipping_line1,
              line2: cart.shipping_line2 ?? null,
              city: cart.shipping_city ?? null,
              state: cart.shipping_state ?? null,
              postal_code: cart.shipping_postal_code ?? null,
              country: cart.shipping_country ?? null,
            })
          : null,
        subtotalCents,
        shippingCents,
        totalCents,
        currency,
        cart.discount_code || null,
        cart.discount_id || null,
        discountCents,
        cart.taxes_json || JSON.stringify([]),
        uuid(),
        cart.locale || 'en-US',
        tranId,
      ]
    );
    for (const item of items) {
      await db.run(
        `INSERT INTO order_items (id, order_id, sku, title, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?)`,
        [uuid(), orderId, item.sku, item.title, item.qty, item.unit_price_cents]
      );
    }

    const apiUrl = new URL(c.req.url).origin;

    const payload = new URLSearchParams({
      store_id: sslConfig.store_id,
      store_passwd: storePassword,
      total_amount: toGatewayAmount(totalCents),
      currency,
      tran_id: tranId,
      // SSLCommerz sends the shopper back with a POST, which a static SPA host
      // (GitHub Pages) can't accept, so it returns to the API, which redirects.
      success_url: `${apiUrl}/v1/webhooks/sslcommerz/return/success`,
      fail_url: `${apiUrl}/v1/webhooks/sslcommerz/return/fail`,
      cancel_url: `${apiUrl}/v1/webhooks/sslcommerz/return/cancel`,
      ipn_url: `${apiUrl}/v1/webhooks/sslcommerz/ipn`,
      cus_name: cart.shipping_name || cart.customer_email.split('@')[0] || 'Customer',
      cus_email: cart.customer_email,
      cus_phone: cart.shipping_phone || '01700000000', // required by SSLCommerz
      cus_add1: cart.shipping_line1 || 'N/A',
      cus_city: cart.shipping_city || 'Dhaka',
      cus_country: cart.shipping_country || 'Bangladesh',
      shipping_method: 'NO',
      num_of_item: String(items.reduce((sum: number, item: any) => sum + item.qty, 0)),
      product_name: items.map((i: any) => i.title).join(', ').slice(0, 255),
      product_category: 'ecommerce',
      product_profile: 'general',
      value_a: cartId,
    });

    const response = await fetch(`${getSslBaseUrl(sslConfig.sandbox)}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 200)}`); }
    if (json.status !== 'SUCCESS' || !json.GatewayPageURL) {
      throw new Error(json.failedreason || 'No GatewayPageURL returned from SSLCommerz');
    }

    await db.run(
      `UPDATE carts SET stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`,
      [tranId, now(), cartId]
    );
    return c.json({ gateway_url: json.GatewayPageURL }, 200);
  } catch (err: any) {
    await rollback();
    if (err instanceof ApiError) throw err;
    throw ApiError.invalidRequest(`Failed to initiate SSLCommerz payment: ${err.message}`);
  }
});

// ─── IPN App (mounted at /v1/webhooks/sslcommerz) ────────────────────
export const sslcommerzIpnApp = new OpenAPIHono<HonoEnv>();

/**
 * Where the shopper's browser lands after paying, failing or cancelling.
 * This is navigation only: the order is marked paid by the IPN after
 * server-side validation, never here. The target is always STORE_URL, so this
 * can't be used as an open redirect.
 */
export function sslcommerzReturnLocation(
  storeUrl: string,
  result: string,
  tranId: string | null,
  /** A Buy now payment: its item, or 'buy_now' when the item can't be found. */
  buyNow: BuyNowReturn | 'buy_now' | null = null,
): string {
  const base = storeUrl.replace(/\/+$/, '');
  if (result === 'success') {
    return `${base}/success?gateway=sslcommerz${tranId ? `&tran_id=${encodeURIComponent(tranId)}` : ''}${buyNow ? '&source=buy_now' : ''}`;
  }
  const payment = result === 'cancel' ? 'cancelled' : 'failed';
  if (buyNow && buyNow !== 'buy_now') {
    const q = new URLSearchParams({ product: buyNow.productId, sku: buyNow.sku, qty: String(buyNow.qty), payment });
    return `${base}/buy-now?${q.toString()}`;
  }
  return `${base}/cart?payment=${payment}`;
}

/** The one product of a Buy now checkout, so the shopper can go back to it. */
export interface BuyNowReturn {
  productId: string;
  sku: string;
  qty: number;
}

/**
 * Was this payment a Buy now checkout? The order (found by tran_id, which is
 * never cleared) gives the item; its cart is the one that stored the tran_id,
 * or, once a FAILED IPN has reopened that cart and cleared it, the value_a cart
 * id SSLCommerz posts back. That cart only counts when it is a buy_now cart of
 * the same shopper. Navigation only: nothing here changes an order or a cart.
 */
async function findBuyNowReturn(db: Database, tranId: string | null, valueA: string | null): Promise<BuyNowReturn | 'buy_now' | null> {
  if (!tranId) return null;
  const [order] = await db.query<{ id: string; customer_email: string }>(
    `SELECT id, customer_email FROM orders WHERE sslcommerz_tran_id = ? AND payment_gateway = 'sslcommerz'`,
    [tranId],
  );
  if (!order) return null;
  const [cart] = await db.query<{ source: string; customer_email: string }>(
    `SELECT source, customer_email FROM carts
     WHERE stripe_checkout_session_id = ? OR id = ?
     ORDER BY (stripe_checkout_session_id = ?) DESC LIMIT 1`,
    [tranId, valueA ?? '', tranId],
  );
  if (!cart || cart.source !== 'buy_now' || cart.customer_email !== order.customer_email) return null;
  // From here on it is a Buy now payment, item or not: the success page must keep the cart.
  try {
    const [item] = await db.query<{ sku: string; qty: number; product_id: string | null }>(
      `SELECT oi.sku, oi.qty, v.product_id FROM order_items oi
       LEFT JOIN variants v ON v.sku = oi.sku
       WHERE oi.order_id = ? ORDER BY oi.rowid LIMIT 1`,
      [order.id],
    );
    return item?.product_id ? { productId: item.product_id, sku: item.sku, qty: item.qty } : 'buy_now';
  } catch (err) {
    console.error('SSLCommerz return: Buy now item lookup failed', err);
    return 'buy_now';
  }
}

sslcommerzIpnApp.on(['GET', 'POST'], '/return/:result', async (c) => {
  let tranId = c.req.query('tran_id') ?? null;
  let valueA = c.req.query('value_a') ?? null;
  if (c.req.method === 'POST') {
    const form = new URLSearchParams(await c.req.text());
    tranId = form.get('tran_id') ?? tranId;
    valueA = form.get('value_a') ?? valueA;
  }
  const storeUrl = c.env.STORE_URL || 'http://localhost:5173';
  let buyNow: BuyNowReturn | 'buy_now' | null = null;
  try {
    buyNow = await findBuyNowReturn(getDb(c.var.db), tranId, valueA);
  } catch (err) {
    // Never block the shopper's way back over this lookup.
    console.error('SSLCommerz return: Buy now lookup failed', err);
  }
  return c.redirect(sslcommerzReturnLocation(storeUrl, c.req.param('result'), tranId, buyNow), 303);
});

const ipnRoute = createRoute({
  method: 'post',
  path: '/ipn',
  tags: ['SSLCommerz'],
  summary: 'SSLCommerz IPN Handler',
  responses: {
    200: { content: { 'application/json': { schema: z.object({ response: z.string() }) } }, description: 'IPN received' },
    500: { content: { 'application/json': { schema: z.object({ response: z.string() }) } }, description: 'Validation unavailable; SSLCommerz retries' },
  },
});

/** Releases the stock reserved at checkout for an order's physical items. */
async function releaseOrderReservations(db: ReturnType<typeof getDb>, orderId: string) {
  const items = await db.query<any>(
    `SELECT oi.sku, oi.qty, v.variant_type FROM order_items oi
     LEFT JOIN variants v ON v.sku = oi.sku WHERE oi.order_id = ?`,
    [orderId]
  );
  for (const item of items) {
    if (!item.variant_type || item.variant_type === 'physical') {
      await releaseReservation(db, item.sku, item.qty);
    }
  }
}

sslcommerzIpnApp.openapi(ipnRoute, async (c) => {
  const ack = () => c.json({ response: 'IPN received' }, 200);
  try {
    const params = new URLSearchParams(await c.req.text());
    const tranId = params.get('tran_id');
    const outcome = classifyIpnStatus(params.get('status'));
    if (!tranId || outcome === 'ignore') return ack();

    const db = getDb(c.var.db);
    const [order] = await db.query<any>(
      `SELECT * FROM orders WHERE sslcommerz_tran_id = ? AND payment_gateway = 'sslcommerz'`,
      [tranId]
    );
    if (!order || order.status !== 'pending') return ack(); // unknown or already settled

    if (outcome === 'failure') {
      // tran_id is a random UUID, so this can't be triggered for someone else's order by guessing.
      const res = await db.run(
        `UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'`,
        [order.id]
      );
      if (res.changes === 1) {
        await releaseOrderReservations(db, order.id);
        await db.run(
          `UPDATE carts SET status = 'open', stripe_checkout_session_id = NULL, updated_at = ?
           WHERE stripe_checkout_session_id = ? AND status = 'checked_out'`,
          [now(), tranId]
        );
      }
      return ack();
    }

    // Success: confirm with SSLCommerz server-side. The IPN body is unauthenticated.
    const valId = params.get('val_id');
    const sslConfig = await getSslConfig(c);
    const storePassword = await getDecryptedSslPassword(c);
    if (!valId || !sslConfig.enabled || !storePassword) return ack();

    const query = new URLSearchParams({
      val_id: valId,
      store_id: sslConfig.store_id,
      store_passwd: storePassword,
      format: 'json',
    });
    let validation: SslValidationResponse | null = null;
    try {
      const resp = await fetch(
        `${getSslBaseUrl(sslConfig.sandbox)}/validator/api/validationserverAPI.php?${query}`
      );
      validation = (await resp.json()) as SslValidationResponse;
    } catch (err) {
      console.error('SSLCommerz validation API error:', err);
      return c.json({ response: 'validation unavailable' }, 500); // let SSLCommerz retry
    }

    if (!isValidatedPayment(validation, { tranId, totalCents: order.total_cents, currency: order.currency })) {
      console.warn('SSLCommerz IPN rejected: validation mismatch', { tranId, status: validation?.status });
      return ack();
    }

    const paid = await db.run(
      `UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'pending'`,
      [order.id]
    );
    if (paid.changes !== 1) return ack(); // a concurrent IPN already handled it

    const orderItems = await db.query<any>(
      `SELECT oi.*, v.variant_type FROM order_items oi
       LEFT JOIN variants v ON v.sku = oi.sku WHERE oi.order_id = ?`,
      [order.id]
    );
    for (const item of orderItems) {
      if (!item.variant_type || item.variant_type === 'physical') {
        await commitSale(db, item.sku, item.qty);
        await db.run(
          `INSERT INTO inventory_logs (id, sku, delta, reason) VALUES (?, ?, ?, 'sale')`,
          [uuid(), item.sku, -item.qty]
        );
      }
    }

    // Link to the customer (created if this is their first order) and
    // recalculate their order count and money spent from their orders.
    await linkOrderToCustomer(db, order.id, { name: order.shipping_name ?? null });

    // Same as the Stripe webhook: keep the cart from being treated as abandoned.
    await db.run(
      `UPDATE carts SET status = 'expired', updated_at = ? WHERE stripe_checkout_session_id = ?`,
      [now(), tranId]
    );

    try {
      await dispatchWebhooks(c.var.db as any, c.env as any, 'order.created', {
        orderId: order.id, orderNumber: order.number, customerEmail: order.customer_email,
        totalCents: order.total_cents, currency: order.currency, gateway: 'sslcommerz',
      });
    } catch (err) { console.error('Webhook dispatch failed:', err); }

    return ack();
  } catch (err: any) {
    console.error('SSLCommerz IPN handler error:', err);
    return ack();
  }
});
