import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  classifyIpnStatus,
  gatewayAmountToCents,
  isSupportedCurrency,
  isValidatedPayment,
  toGatewayAmount,
} from '../src/lib/sslcommerz';
import { sslcommerzCheckoutApp, sslcommerzIpnApp, sslcommerzReturnLocation } from '../src/routes/sslcommerz-ipn';
import { ApiError, type HonoEnv } from '../src/types';
import { createMerchantDb } from './helpers/merchant-db';

// ─── Pure rules ──────────────────────────────────────────────────────

describe('sslcommerz helpers', () => {
  it('converts cents to decimal major units and back', () => {
    expect(toGatewayAmount(125050)).toBe('1250.50');
    expect(toGatewayAmount(99)).toBe('0.99');
    expect(gatewayAmountToCents('1250.50')).toBe(125050);
    expect(gatewayAmountToCents('abc')).toBeNull();
    expect(gatewayAmountToCents(undefined)).toBeNull();
  });

  it('accepts only gateway-supported currencies', () => {
    expect(isSupportedCurrency('bdt')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('JPY')).toBe(false);
    expect(isSupportedCurrency(null)).toBe(false);
  });

  it('classifies IPN statuses (success is VALID, not SUCCESS)', () => {
    expect(classifyIpnStatus('VALID')).toBe('success');
    expect(classifyIpnStatus('VALIDATED')).toBe('success');
    expect(classifyIpnStatus('FAILED')).toBe('failure');
    expect(classifyIpnStatus('CANCELLED')).toBe('failure');
    expect(classifyIpnStatus('SUCCESS')).toBe('ignore');
    expect(classifyIpnStatus(undefined)).toBe('ignore');
  });

  describe('isValidatedPayment', () => {
    const expected = { tranId: 'TXN-1', totalCents: 150000, currency: 'BDT' };

    it('accepts a matching VALID response', () => {
      expect(isValidatedPayment({ status: 'VALID', tran_id: 'TXN-1', amount: '1500.00', currency: 'BDT' }, expected)).toBe(true);
    });

    it('uses currency_type/currency_amount for non-BDT payments', () => {
      const usd = { tranId: 'TXN-2', totalCents: 2000, currency: 'USD' };
      expect(isValidatedPayment(
        { status: 'VALID', tran_id: 'TXN-2', amount: '2400.00', currency: 'BDT', currency_type: 'USD', currency_amount: '20.00' },
        usd
      )).toBe(true);
    });

    it('rejects wrong status, transaction, amount or currency', () => {
      const ok = { status: 'VALID', tran_id: 'TXN-1', amount: '1500.00', currency: 'BDT' };
      expect(isValidatedPayment(null, expected)).toBe(false);
      expect(isValidatedPayment({ ...ok, status: 'INVALID_TRANSACTION' }, expected)).toBe(false);
      expect(isValidatedPayment({ ...ok, tran_id: 'TXN-other' }, expected)).toBe(false);
      expect(isValidatedPayment({ ...ok, amount: '1.00' }, expected)).toBe(false);
      expect(isValidatedPayment({ ...ok, currency: 'USD' }, expected)).toBe(false);
    });
  });
});

// ─── Routes against the real MerchantDO schema ──────────────────────

const CRYPTOKEN = 'test-cryptoken';
const STORE_PASSWORD = 'store-pass';
const CART_ID = '11111111-1111-4111-8111-111111111111';

/** Mirrors decryptSecret() in sslcommerz-ipn.ts (PBKDF2 → AES-CBC, salt prefix). */
async function encryptSecret(plain: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, baseKey, 384)
  );
  const key = await crypto.subtle.importKey('raw', derived.slice(0, 32), 'AES-CBC', false, ['encrypt']);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: derived.slice(32, 48) }, key, new TextEncoder().encode(plain))
  );
  return btoa(String.fromCharCode(...salt, ...ct));
}

async function setup(opts: { currency?: string; onHand?: number; source?: 'cart' | 'buy_now' } = {}) {
  const { merchant } = createMerchantDb();
  const run = (sql: string, params: unknown[] = []) => merchant.run(sql, params);

  run(`INSERT INTO config (key, value) VALUES ('payment_gateway.sslcommerz', ?)`, [
    JSON.stringify({ enabled: true, sandbox: true, store_id: 'teststore', store_password: await encryptSecret(STORE_PASSWORD, CRYPTOKEN) }),
  ]);
  run(`INSERT INTO products (id, title) VALUES ('p1', 'Tee')`);
  run(`INSERT INTO variants (id, product_id, sku, title, price_cents, variant_type) VALUES ('v1', 'p1', 'TEE-1', 'Tee', 75000, 'physical')`);
  run(`INSERT INTO inventory (id, sku, on_hand, reserved) VALUES ('i1', 'TEE-1', ?, 0)`, [opts.onHand ?? 10]);
  run(`INSERT INTO customers (id, email) VALUES ('c1', 'buyer@example.com')`);
  run(
    `INSERT INTO carts (id, status, customer_email, currency, shipping_cents, expires_at, source)
     VALUES (?, 'open', 'buyer@example.com', ?, 0, '2099-01-01T00:00:00Z', ?)`,
    [CART_ID, opts.currency ?? 'BDT', opts.source ?? 'cart']
  );
  run(
    `INSERT INTO cart_items (id, cart_id, sku, title, qty, unit_price_cents) VALUES ('ci1', ?, 'TEE-1', 'Tee', 2, 75000)`,
    [CART_ID]
  );

  const app = new Hono<HonoEnv>();
  app.onError((err, c) =>
    c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400)
  );
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/carts', sslcommerzCheckoutApp);
  app.route('/v1/webhooks/sslcommerz', sslcommerzIpnApp);

  const env = { CRYPTOKEN, STORE_URL: 'https://shop.test' };
  const q = <T = any>(sql: string, params: unknown[] = []) => merchant.query<T>(sql, params);
  const checkout = () =>
    app.request(`https://api.test/v1/carts/${CART_ID}/checkout/sslcommerz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }, env as never);
  const ipn = (fields: Record<string, string>) =>
    app.request('https://api.test/v1/webhooks/sslcommerz/ipn', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }, env as never);

  const raw = (path: string, init?: RequestInit) => app.request(`https://api.test${path}`, init, env as never);

  return { q, checkout, ipn, raw };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function gatewayReturns(body: unknown) {
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(body)));
}

async function checkedOut(opts?: Parameters<typeof setup>[0]) {
  const t = await setup(opts);
  gatewayReturns({ status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/pay/x' });
  const res = await t.checkout();
  expect(res.status).toBe(200);
  const [order] = t.q(`SELECT * FROM orders`);
  return { ...t, order };
}

describe('POST /v1/carts/:id/checkout/sslcommerz', () => {
  it('creates a pending order with items, reserves stock, and sends the amount in major units', async () => {
    const { q, order } = await checkedOut();

    expect(order).toMatchObject({ status: 'pending', payment_gateway: 'sslcommerz', total_cents: 150000, currency: 'BDT', customer_id: 'c1' });
    expect(order.sslcommerz_tran_id).toMatch(/^TXN-[0-9a-f-]{36}$/);
    expect(q(`SELECT sku, qty FROM order_items WHERE order_id = ?`, [order.id])).toEqual([{ sku: 'TEE-1', qty: 2 }]);
    expect(q(`SELECT reserved FROM inventory WHERE sku = 'TEE-1'`)[0].reserved).toBe(2);
    expect(q(`SELECT status, stripe_checkout_session_id FROM carts`)[0]).toEqual({
      status: 'checked_out',
      stripe_checkout_session_id: order.sslcommerz_tran_id,
    });

    const sent = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sent.get('total_amount')).toBe('1500.00');
    expect(sent.get('currency')).toBe('BDT');
    expect(sent.get('tran_id')).toBe(order.sslcommerz_tran_id);
    expect(sent.get('ipn_url')).toBe('https://api.test/v1/webhooks/sslcommerz/ipn');
    expect(sent.get('success_url')).toBe('https://api.test/v1/webhooks/sslcommerz/return/success');
    expect(sent.get('fail_url')).toBe('https://api.test/v1/webhooks/sslcommerz/return/fail');
    expect(sent.get('cancel_url')).toBe('https://api.test/v1/webhooks/sslcommerz/return/cancel');
  });

  it('passes non-BDT currencies through without a hardcoded exchange rate', async () => {
    await checkedOut({ currency: 'USD' });
    const sent = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(sent.get('currency')).toBe('USD');
    expect(sent.get('total_amount')).toBe('1500.00');
  });

  it('rejects unsupported currencies and leaves the cart open', async () => {
    const { q, checkout } = await setup({ currency: 'JPY' });
    expect((await checkout()).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q(`SELECT status FROM carts`)[0].status).toBe('open');
  });

  it('rolls back order, reservation and cart when the gateway fails', async () => {
    const { q, checkout } = await setup();
    gatewayReturns({ status: 'FAILED', failedreason: 'Store credential error' });

    const res = await checkout();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Store credential error');
    expect(q(`SELECT COUNT(*) AS n FROM orders`)[0].n).toBe(0);
    expect(q(`SELECT COUNT(*) AS n FROM order_items`)[0].n).toBe(0);
    expect(q(`SELECT reserved FROM inventory`)[0].reserved).toBe(0);
    expect(q(`SELECT status FROM carts`)[0].status).toBe('open');
  });

  it('rejects when stock is insufficient', async () => {
    const { q, checkout } = await setup({ onHand: 1 });
    expect((await checkout()).status).toBe(409); // ApiError.insufficientInventory
    expect(q(`SELECT status FROM carts`)[0].status).toBe('open');
  });
});

describe('POST /v1/webhooks/sslcommerz/ipn', () => {
  function validatorReturns(body: unknown) {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(body)));
  }

  it('marks the order paid after server-side validation and commits stock', async () => {
    const { q, ipn, order } = await checkedOut();
    validatorReturns({ status: 'VALID', tran_id: order.sslcommerz_tran_id, amount: '1500.00', currency: 'BDT' });

    const res = await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'val-1' });
    expect(res.status).toBe(200);

    const validatorUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(validatorUrl.pathname).toBe('/validator/api/validationserverAPI.php');
    expect(validatorUrl.searchParams.get('val_id')).toBe('val-1');

    expect(q(`SELECT status FROM orders`)[0].status).toBe('paid');
    expect(q(`SELECT on_hand, reserved FROM inventory`)[0]).toEqual({ on_hand: 8, reserved: 0 });
    expect(q(`SELECT order_count, total_spent_cents FROM customers WHERE id = 'c1'`)[0]).toEqual({ order_count: 1, total_spent_cents: 150000 });
    expect(q(`SELECT status FROM carts`)[0].status).toBe('expired');
  });

  it('is idempotent: a repeated IPN does not commit stock twice', async () => {
    const { q, ipn, order } = await checkedOut();
    const validation = { status: 'VALID', tran_id: order.sslcommerz_tran_id, amount: '1500.00', currency: 'BDT' };
    validatorReturns(validation);
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'val-1' });
    validatorReturns({ ...validation, status: 'VALIDATED' });
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'val-1' });

    expect(q(`SELECT on_hand FROM inventory`)[0].on_hand).toBe(8);
    expect(q(`SELECT order_count FROM customers WHERE id = 'c1'`)[0].order_count).toBe(1);
  });

  it('does NOT mark paid when the validator disagrees (forged IPN)', async () => {
    const { q, ipn, order } = await checkedOut();
    validatorReturns({ status: 'INVALID_TRANSACTION' });
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'forged' });
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending');
  });

  it('does NOT mark paid when the validated amount differs', async () => {
    const { q, ipn, order } = await checkedOut();
    validatorReturns({ status: 'VALID', tran_id: order.sslcommerz_tran_id, amount: '10.00', currency: 'BDT' });
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'val-1' });
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending');
  });

  it('returns 500 (so SSLCommerz retries) and leaves the order pending when the validator is unreachable', async () => {
    const { q, ipn, order } = await checkedOut();
    fetchMock.mockImplementationOnce(async () => { throw new Error('network down'); });
    const res = await ipn({ tran_id: order.sslcommerz_tran_id, status: 'VALID', val_id: 'val-1' });
    expect(res.status).toBe(500);
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending');
  });

  it('cancels the order, releases stock and reopens the cart on FAILED', async () => {
    const { q, ipn, order } = await checkedOut();
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'FAILED' });

    expect(q(`SELECT status FROM orders`)[0].status).toBe('canceled');
    expect(q(`SELECT on_hand, reserved FROM inventory`)[0]).toEqual({ on_hand: 10, reserved: 0 });
    expect(q(`SELECT status FROM carts`)[0].status).toBe('open');
  });

  it('ignores unknown transactions', async () => {
    const { q, ipn } = await checkedOut();
    const res = await ipn({ tran_id: 'TXN-unknown', status: 'FAILED' });
    expect(res.status).toBe(200);
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending');
  });
});

describe('SSLCommerz return redirect', () => {
  it('builds store URLs and never redirects off STORE_URL', () => {
    expect(sslcommerzReturnLocation('https://shop.test/', 'success', 'TXN-1')).toBe('https://shop.test/success?gateway=sslcommerz&tran_id=TXN-1');
    expect(sslcommerzReturnLocation('https://shop.test', 'fail', null)).toBe('https://shop.test/cart?payment=failed');
    expect(sslcommerzReturnLocation('https://shop.test', 'cancel', null)).toBe('https://shop.test/cart?payment=cancelled');
    expect(sslcommerzReturnLocation('https://shop.test', '//evil.example', null)).toBe('https://shop.test/cart?payment=failed');
  });

  it('accepts the POST from SSLCommerz and 303-redirects to the store, without touching the order', async () => {
    const { raw, q, order } = await checkedOut();
    const res = await raw('/v1/webhooks/sslcommerz/return/success', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tran_id: order.sslcommerz_tran_id, status: 'VALID' }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      `https://shop.test/success?gateway=sslcommerz&tran_id=${encodeURIComponent(order.sslcommerz_tran_id)}`
    );
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending'); // only the IPN marks paid
  });
});

describe('SSLCommerz return for Buy now', () => {
  const BUY_NOW = { productId: 'p1', sku: 'TEE-1', qty: 2 };
  const back = (result: string, tranId: string, fields: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tran_id: tranId, value_a: CART_ID, ...fields }).toString(),
  });

  it('buy-now return targets', () => {
    expect(sslcommerzReturnLocation('https://shop.test/', 'success', 'TXN-1', BUY_NOW)).toBe(
      'https://shop.test/success?gateway=sslcommerz&tran_id=TXN-1&source=buy_now',
    );
    expect(sslcommerzReturnLocation('https://shop.test', 'fail', 'TXN-1', BUY_NOW)).toBe(
      'https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=failed',
    );
    expect(sslcommerzReturnLocation('https://shop.test', 'cancel', 'TXN-1', BUY_NOW)).toBe(
      'https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=cancelled',
    );
    expect(sslcommerzReturnLocation('https://shop.test', 'fail', null, { productId: 'a b', sku: 'S&K=U', qty: 1 })).toBe(
      'https://shop.test/buy-now?product=a+b&sku=S%26K%3DU&qty=1&payment=failed',
    );
  });

  it('sends a failed or cancelled Buy now payment back to the Buy now page', async () => {
    const { raw, order } = await checkedOut({ source: 'buy_now' });
    const fail = await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', order.sslcommerz_tran_id));
    expect(fail.status).toBe(303);
    expect(fail.headers.get('location')).toBe('https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=failed');
    const cancel = await raw('/v1/webhooks/sslcommerz/return/cancel', back('cancel', order.sslcommerz_tran_id));
    expect(cancel.headers.get('location')).toBe('https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=cancelled');
  });

  it('still finds the Buy now page after the FAILED IPN reopened the cart', async () => {
    const { raw, ipn, order, q } = await checkedOut({ source: 'buy_now' });
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'FAILED' });
    expect(q(`SELECT stripe_checkout_session_id FROM carts`)[0].stripe_checkout_session_id).toBeNull();
    const res = await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', order.sslcommerz_tran_id));
    expect(res.headers.get('location')).toBe('https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=failed');
  });

  it('marks a successful Buy now return so the success page keeps the cart', async () => {
    const { raw, order, q } = await checkedOut({ source: 'buy_now' });
    const res = await raw('/v1/webhooks/sslcommerz/return/success', back('success', order.sslcommerz_tran_id, { status: 'VALID' }));
    expect(res.headers.get('location')).toBe(
      `https://shop.test/success?gateway=sslcommerz&tran_id=${encodeURIComponent(order.sslcommerz_tran_id)}&source=buy_now`,
    );
    expect(q(`SELECT status FROM orders`)[0].status).toBe('pending'); // only the IPN marks paid
  });

  it('a GET return with the query string works the same', async () => {
    const { raw, order } = await checkedOut({ source: 'buy_now' });
    const qs = new URLSearchParams({ tran_id: order.sslcommerz_tran_id, value_a: CART_ID }).toString();
    const res = await raw(`/v1/webhooks/sslcommerz/return/cancel?${qs}`);
    expect(res.headers.get('location')).toBe('https://shop.test/buy-now?product=p1&sku=TEE-1&qty=2&payment=cancelled');
  });

  it('keeps the Buy now flag on success even when the product is gone', async () => {
    const { raw, order, q } = await checkedOut({ source: 'buy_now' });
    q(`DELETE FROM variants WHERE sku = 'TEE-1'`);
    const ok = await raw('/v1/webhooks/sslcommerz/return/success', back('success', order.sslcommerz_tran_id));
    expect(ok.headers.get('location')).toContain('&source=buy_now');
    // fail can't rebuild the Buy now page without the product: today's target
    const fail = await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', order.sslcommerz_tran_id));
    expect(fail.headers.get('location')).toBe('https://shop.test/cart?payment=failed');
  });

  it('keeps the Buy now flag after the success IPN expired the cart', async () => {
    const { raw, order, q } = await checkedOut({ source: 'buy_now' });
    q(`UPDATE carts SET status = 'expired'`); // what the VALID IPN does
    const res = await raw('/v1/webhooks/sslcommerz/return/success', back('success', order.sslcommerz_tran_id));
    expect(res.headers.get('location')).toContain('&source=buy_now');
  });

  it('without value_a after a FAILED IPN, falls back to the cart page', async () => {
    const { raw, ipn, order } = await checkedOut({ source: 'buy_now' });
    await ipn({ tran_id: order.sslcommerz_tran_id, status: 'FAILED' });
    const res = await raw('/v1/webhooks/sslcommerz/return/fail', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tran_id: order.sslcommerz_tran_id }).toString(),
    });
    expect(res.headers.get('location')).toBe('https://shop.test/cart?payment=failed');
  });

  it('cart checkouts keep today\'s targets', async () => {
    const { raw, order } = await checkedOut();
    const res = await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', order.sslcommerz_tran_id));
    expect(res.headers.get('location')).toBe('https://shop.test/cart?payment=failed');
  });

  it('unknown tran_id keeps today\'s targets', async () => {
    const { raw } = await checkedOut({ source: 'buy_now' });
    expect((await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', 'TXN-none'))).headers.get('location')).toBe(
      'https://shop.test/cart?payment=failed',
    );
    expect((await raw('/v1/webhooks/sslcommerz/return/success', back('success', 'TXN-none'))).headers.get('location')).toBe(
      'https://shop.test/success?gateway=sslcommerz&tran_id=TXN-none',
    );
    const none = await raw('/v1/webhooks/sslcommerz/return/fail', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
    expect(none.headers.get('location')).toBe('https://shop.test/cart?payment=failed');
  });

  it('ignores a value_a that points at someone else\'s Buy now cart', async () => {
    const { raw, order, q } = await checkedOut();
    // A different shopper's buy-now cart
    q(`INSERT INTO carts (id, status, customer_email, currency, expires_at, source) VALUES ('other', 'open', 'x@example.com', 'BDT', '2099-01-01T00:00:00Z', 'buy_now')`);
    const res = await raw('/v1/webhooks/sslcommerz/return/fail', back('fail', order.sslcommerz_tran_id, { value_a: 'other' }));
    expect(res.headers.get('location')).toBe('https://shop.test/cart?payment=failed');
  });
});
