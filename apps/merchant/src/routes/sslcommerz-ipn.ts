// apps/merchant/src/routes/sslcommerz-ipn.ts
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HonoEnv, ApiError, uuid, now } from '../types';
import { getDb } from '../db';
import { dispatchWebhooks } from '../lib/webhooks';

// ─── Encryption helper ────────────────────────────────────────────────
async function decryptSecret(base64Ciphertext: string, password: string): Promise<string> {
  const raw = Uint8Array.from(atob(base64Ciphertext.trim()), c => c.charCodeAt(0));
  const salt = raw.slice(0, 8);
  const ciphertext = raw.slice(8);
  const pwBytes = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
      baseKey, 384
    )
  );
  const aesKey = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, ['decrypt']);
  const iv = derived.slice(32, 48);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ─── Helpers ──────────────────────────────────────────────────────────
async function getDecryptedSslPassword(c: any): Promise<string | null> {
  const db = getDb(c.var.db);
  const [row] = await db.query<any>(`SELECT value FROM config WHERE key = 'payment_gateway.sslcommerz'`);
  if (!row || !row.value) return null;
  let parsed: any;
  try { parsed = JSON.parse(row.value); } catch { return null; }
  if (!parsed.enabled || !parsed.store_password || !parsed.store_id) return null;
  const cryptoken = c.env.CRYPTOKEN;
  if (!cryptoken) return null;
  try { return await decryptSecret(parsed.store_password, cryptoken); } catch { return null; }
}

async function getSslConfig(c: any): Promise<{ enabled: boolean; store_id: string; sandbox: boolean }> {
  const db = getDb(c.var.db);
  const [row] = await db.query<any>(`SELECT value FROM config WHERE key = 'payment_gateway.sslcommerz'`);
  if (!row || !row.value) return { enabled: false, store_id: '', sandbox: true };
  let parsed: any;
  try { parsed = JSON.parse(row.value); } catch { return { enabled: false, store_id: '', sandbox: true }; }
  return { enabled: parsed.enabled === true, store_id: parsed.store_id || '', sandbox: parsed.sandbox !== false };
}

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

  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);
  if (!cart) throw ApiError.notFound('Cart not found');
  if (cart.status !== 'open') throw ApiError.conflict('Cart is not open');

  const sslConfig = await getSslConfig(c);
  if (!sslConfig.enabled || !sslConfig.store_id) throw ApiError.invalidRequest('SSLCommerz is not configured.');

  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);
  if (items.length === 0) throw ApiError.invalidRequest('Cart is empty');

  const storePassword = await getDecryptedSslPassword(c);
  if (!storePassword) throw ApiError.invalidRequest('SSLCommerz password is not configured.');

  const tranId = `TXN-${Date.now()}-${cartId.slice(0, 8)}`;
  const subtotalCents = items.reduce((sum: number, item: any) => sum + item.unit_price_cents * item.qty, 0);
  const shippingCents = cart.shipping_cents || 0;
  const discountCents = cart.discount_amount_cents || 0;
  const totalCents = subtotalCents - discountCents + shippingCents;

  let totalAmount = totalCents;
  let currency = cart.currency || 'USD';
  if (currency !== 'BDT') {
    totalAmount = Math.round(totalCents * 120); // approx USD->BDT
    currency = 'BDT';
  }

  const storeUrl = c.env.STORE_URL || 'http://localhost:5173';
const apiUrl = new URL(c.req.url).origin;  
  const successUrl = `${storeUrl}/success?gateway=sslcommerz&tran_id=${encodeURIComponent(tranId)}`;
  const failUrl = `${storeUrl}/cart?payment=failed`;
  const cancelUrl = `${storeUrl}/cart?payment=cancelled`;
  const ipnUrl = `${apiUrl}/v1/webhooks/sslcommerz/ipn`;

  const cusName = cart.customer_email.split('@')[0] || 'Customer';
  const cusEmail = cart.customer_email;
  const cusPhone = '01700000000'; // Required by SSLCommerz, default if missing

  const sslPayload = new URLSearchParams();
  sslPayload.set('store_id', sslConfig.store_id);
  sslPayload.set('store_passwd', storePassword);
  sslPayload.set('total_amount', String(totalAmount));
  sslPayload.set('currency', currency);
  sslPayload.set('tran_id', tranId);
  sslPayload.set('success_url', successUrl);
  sslPayload.set('fail_url', failUrl);
  sslPayload.set('cancel_url', cancelUrl);
  sslPayload.set('ipn_url', ipnUrl);
  sslPayload.set('cus_name', cusName);
  sslPayload.set('cus_email', cusEmail);
  sslPayload.set('cus_phone', cusPhone);
  sslPayload.set('cus_add1', cart.shipping_line1 || 'N/A');
  sslPayload.set('cus_city', cart.shipping_city || 'Dhaka');
  sslPayload.set('cus_country', cart.shipping_country || 'Bangladesh');
  sslPayload.set('shipping_method', shippingCents > 0 ? 'YES' : 'NO');
  
  if (shippingCents > 0) {
    const shippingAmount = currency === 'BDT' ? Math.round(shippingCents * 120) : shippingCents;
    sslPayload.set('num_of_item', String(items.reduce((sum: number, item: any) => sum + item.qty, 0)));
    sslPayload.set('product_amount', String(totalCents));
    sslPayload.set('shipping_cost', String(shippingAmount));
  }

  let product_name = items.map((i: any) => i.title).join(', ');
  sslPayload.set('product_name', product_name.slice(0, 255));
  sslPayload.set('product_category', 'ecommerce');
  sslPayload.set('product_profile', 'general');

  // Create the order record
  const orderId = uuid();
  const viewtoken = uuid();
  await db.run(
    `INSERT INTO orders (id, customer_id, number, status, customer_email, region_id, warehouse_id,
     shipping_name, ship_to, subtotal_cents, tax_cents, shipping_cents, total_cents, currency,
     discount_code, discount_amount_cents, tracking_number, tracking_url, stripe_checkout_session_id,
     taxes_json, viewtoken, viewtoken_issued_at, locale, sslcommerz_tran_id, payment_gateway)
     VALUES (?, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, ?, '', 0, NULL, NULL, NULL,
     ?, ?, datetime('now'), ?, ?, 'sslcommerz')`,
    [
      orderId, `ORD-${Date.now().toString(36).toUpperCase()}-${uuid().slice(0, 4).toUpperCase()}`,
      cart.customer_email, cart.region_id || null, cart.shipping_name || null,
      cart.shipping_line1 || cart.customer_email, subtotalCents, shippingCents, totalCents,
      currency.toLowerCase(), JSON.stringify([]), viewtoken, cart.locale || 'en-US', tranId,
    ]
  );

  await db.run(`UPDATE carts SET status = 'checked_out', stripe_checkout_session_id = ?, updated_at = ? WHERE id = ?`, [tranId, now(), cartId]);

  const sslBaseUrl = getSslBaseUrl(sslConfig.sandbox);

  try {
    const response = await fetch(`${sslBaseUrl}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: sslPayload.toString(),
    });

    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`Non-JSON response: ${text.slice(0, 200)}`); }

    if (!json.GatewayPageURL) {
      throw new Error('No GatewayPageURL returned from SSLCommerz');
    }

    return c.json({ gateway_url: json.GatewayPageURL }, 200);
  } catch (err: any) {
    await db.run(`UPDATE carts SET status = 'open', stripe_checkout_session_id = NULL, updated_at = ? WHERE id = ?`, [now(), cartId]);
    throw ApiError.invalidRequest(`Failed to initiate SSLCommerz payment: ${err.message}`);
  }
});

// ─── IPN App (mounted at /v1/webhooks/sslcommerz) ────────────────────
export const sslcommerzIpnApp = new OpenAPIHono<HonoEnv>();

const ipnRoute = createRoute({
  method: 'post',
  path: '/ipn',
  tags: ['SSLCommerz'],
  summary: 'SSLCommerz IPN Handler',
  responses: {
    200: { content: { 'application/json': { schema: z.object({ response: z.string() }) } }, description: 'IPN received' },
  },
});

sslcommerzIpnApp.openapi(ipnRoute, async (c) => {
  try {
    const body = await c.req.text();
    const params = new URLSearchParams(body);

    const tranId = params.get('tran_id');
    const status = params.get('status');
    const valId = params.get('val_id'); // SSLCommerz passes this for validation

    if (!tranId || !status || !valId) {
      console.error('SSLCommerz IPN: missing required fields');
      return c.json({ response: 'IPN received' }, 200);
    }

    const sslConfig = await getSslConfig(c);
    if (!sslConfig.enabled) return c.json({ response: 'IPN received' }, 200);

    const storePassword = await getDecryptedSslPassword(c);
    if (!storePassword) return c.json({ response: 'IPN received' }, 200);

    const validationPayload = new URLSearchParams();
    validationPayload.set('store_id', sslConfig.store_id);
    validationPayload.set('store_passwd', storePassword);
    validationPayload.set('val_id', valId);

    const sslBaseUrl = getSslBaseUrl(sslConfig.sandbox);
    let isValid = false;

    try {
      const resp = await fetch(`${sslBaseUrl}/validator/api/validationserverAPI.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: validationPayload.toString(),
      });
      const respText = await resp.text();
      try {
        const respJson = JSON.parse(respText);
        isValid = respJson.status === 'VALID';
      } catch {
        isValid = respText.trim().toUpperCase() === 'VALID';
      }
    } catch (err) {
      console.error('SSLCommerz validation API error:', err);
      isValid = status === 'SUCCESS' || status === 'COMPLETED';
    }

    const db = getDb(c.var.db);

    if (isValid && (status === 'SUCCESS' || status === 'COMPLETED')) {
      const [order] = await db.query<any>(`SELECT * FROM orders WHERE sslcommerz_tran_id = ? AND status != 'paid'`, [tranId]);

      if (order) {
        await db.run(`UPDATE orders SET status = 'paid', updated_at = ?, sslcommerz_tran_id = ? WHERE id = ?`, [now(), tranId, order.id]);

        const orderItems = await db.query<any>(`SELECT * FROM order_items WHERE order_id = ?`, [order.id]);
        for (const item of orderItems) {
          await db.run(`UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = ? WHERE sku = ?`, [item.qty, item.qty, now(), item.sku]);
        }

        const id = c.env.MERCHANT?.idFromName('default');
        if (id) {
          const stub = c.env.MERCHANT.get(id);
          try {
            await dispatchWebhooks(stub as any, c.env as any, 'order.created', {
              orderId: order.id, orderNumber: order.number, customerEmail: order.customer_email,
              totalCents: order.total_cents, currency: order.currency, gateway: 'sslcommerz',
            });
          } catch (err) { console.error('Webhook dispatch failed:', err); }
        }
      }
    }

    return c.json({ response: 'IPN received' }, 200);
  } catch (err: any) {
    console.error('SSLCommerz IPN handler error:', err);
    return c.json({ response: 'IPN received' }, 200);
  }
});