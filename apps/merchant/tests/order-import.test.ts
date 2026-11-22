/**
 * Marketplace order import against the real MerchantDO schema.
 * eBay responses are fed through the real mapper (mapEbayOrder), so these
 * tests cover eBay JSON → orders / order_items / marketplace_orders / stock.
 */
import { describe, it, expect } from 'vitest';
import { getDb } from '../src/db';
import { importOrders } from '../src/lib/marketplace/order-import';
import { mapEbayOrder, type EbayOrder } from '../src/lib/marketplace/ebay';
import type { MarketOrder } from '../src/lib/marketplace/types';
import { createMerchantDb } from './helpers/merchant-db';

type Merchant = ReturnType<typeof createMerchantDb>['merchant'];

function ebayOrder(overrides: Partial<EbayOrder> = {}): EbayOrder {
  return {
    orderId: '12-34567-89012',
    creationDate: '2026-11-20T08:00:00.000Z',
    orderFulfillmentStatus: 'NOT_STARTED',
    orderPaymentStatus: 'PAID',
    buyer: { username: 'ann', buyerRegistrationAddress: { fullName: 'Ann Buyer', email: 'ann@example.com' } },
    pricingSummary: {
      priceSubtotal: { value: '39.98', currency: 'USD' },
      deliveryCost: { value: '4.50', currency: 'USD' },
      tax: { value: '3.20', currency: 'USD' },
      total: { value: '47.68', currency: 'USD' },
    },
    lineItems: [{ lineItemId: 'LI-1', sku: 'TEE-RED-M', title: 'Red tee', quantity: 2, lineItemCost: { value: '39.98', currency: 'USD' } }],
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: {
            fullName: 'Ann Buyer',
            primaryPhone: { phoneNumber: '555-0100' },
            contactAddress: { addressLine1: '1 Main St', city: 'Springfield', stateOrProvince: 'IL', postalCode: '62701', countryCode: 'US' },
          },
        },
      },
    ],
    ...overrides,
  };
}

/** Stands in for EbayClient.listOrders: real eBay payloads through the real mapper. */
function fakeClient(...orders: EbayOrder[]) {
  return { listOrders: async () => orders.map((o) => mapEbayOrder(o, 'ch1')) };
}

function setup() {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch1', 'ebay', 'default')`);
  merchant.run(`INSERT INTO products (id, title) VALUES ('p1', 'Tee')`);
  merchant.run(`INSERT INTO variants (id, product_id, sku, title, price_cents) VALUES ('v1', 'p1', 'TEE-RED-M', 'Red / M', 1999)`);
  merchant.run(`INSERT INTO variants (id, product_id, sku, title, price_cents, variant_type) VALUES ('v2', 'p1', 'EBOOK', 'E-book', 500, 'digital')`);
  // 10 on hand, 3 already held by someone's cart on the web store.
  merchant.run(`INSERT INTO inventory (id, sku, on_hand, reserved) VALUES ('i1', 'TEE-RED-M', 10, 3)`);
  return { merchant, db: getDb(merchant as never) };
}

const stock = (m: Merchant, sku = 'TEE-RED-M') =>
  m.query<{ on_hand: number; reserved: number }>(`SELECT on_hand, reserved FROM inventory WHERE sku = ?`, [sku])[0];
const count = (m: Merchant, table: string) => m.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe('importOrders', () => {
  it('creates the order, items, marketplace link and customer, and deducts stock', async () => {
    const { merchant, db } = setup();
    const result = await importOrders(db, fakeClient(ebayOrder()), 'ch1');

    expect(result).toMatchObject({ fetched: 1, skipped: [], failed: [], shortfalls: [], unmatchedSkus: [] });
    expect(result.imported).toHaveLength(1);
    const { orderId } = result.imported[0];

    const [order] = merchant.query<any>(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    expect(order).toMatchObject({
      number: 'EBAY-12-34567-89012',
      status: 'paid',
      channel_id: 'ch1',
      customer_email: 'ann@example.com',
      shipping_name: 'Ann Buyer',
      shipping_phone: '555-0100',
      subtotal_cents: 3998,
      tax_cents: 320,
      shipping_cents: 450,
      total_cents: 4768,
      currency: 'USD',
      created_at: '2026-11-20 08:00:00',
    });
    expect(JSON.parse(order.ship_to)).toEqual({
      line1: '1 Main St',
      line2: null,
      city: 'Springfield',
      state: 'IL',
      postal_code: '62701',
      country: 'US',
    });

    expect(merchant.query<any>(`SELECT sku, title, qty, unit_price_cents FROM order_items WHERE order_id = ?`, [orderId])).toEqual([
      { sku: 'TEE-RED-M', title: 'Red tee', qty: 2, unit_price_cents: 1999 },
    ]);

    const [mo] = merchant.query<any>(`SELECT * FROM marketplace_orders`);
    expect(mo).toMatchObject({ channel_id: 'ch1', external_order_id: '12-34567-89012', internal_order_id: orderId, status: 'NOT_STARTED' });
    expect(merchant.query<any>(`SELECT external_line_item_id, sku, qty, inventory_deducted FROM marketplace_order_lines`)).toEqual([
      { external_line_item_id: 'LI-1', sku: 'TEE-RED-M', qty: 2, inventory_deducted: 2 },
    ]);

    const [customer] = merchant.query<any>(`SELECT * FROM customers`);
    expect(customer).toMatchObject({ email: 'ann@example.com', name: 'Ann Buyer', order_count: 1, total_spent_cents: 4768 });
    expect(order.customer_id).toBe(customer.id);

    // on_hand drops by 2; the web cart's 3 reserved units are untouched.
    expect(stock(merchant)).toEqual({ on_hand: 8, reserved: 3 });
    expect(merchant.query<any>(`SELECT sku, delta, reason FROM inventory_logs`)).toEqual([{ sku: 'TEE-RED-M', delta: -2, reason: 'sale' }]);
  });

  it('is idempotent: a second run skips the order and leaves stock alone', async () => {
    const { merchant, db } = setup();
    await importOrders(db, fakeClient(ebayOrder()), 'ch1');
    const second = await importOrders(db, fakeClient(ebayOrder()), 'ch1');

    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toEqual([{ externalOrderId: '12-34567-89012', reason: 'already_imported' }]);
    expect(count(merchant, 'orders')).toBe(1);
    expect(stock(merchant).on_hand).toBe(8);
    expect(merchant.query<any>(`SELECT order_count FROM customers`)[0].order_count).toBe(1);
  });

  it('uses a per-order placeholder customer when the buyer email is masked or missing', async () => {
    const { merchant, db } = setup();
    await importOrders(
      db,
      fakeClient(
        ebayOrder({ orderId: 'A-1', buyer: { buyerRegistrationAddress: { email: 'x9@marketplace.amazon.com' } } }),
        ebayOrder({ orderId: 'A-2', buyer: undefined })
      ),
      'ch1'
    );
    expect(merchant.query<any>(`SELECT email FROM customers ORDER BY email`).map((r) => r.email)).toEqual([
      'buyer-a-1@placeholder.local',
      'buyer-a-2@placeholder.local',
    ]);
    expect(merchant.query<any>(`SELECT customer_email FROM orders ORDER BY number`).map((r) => r.customer_email)).toEqual([
      'buyer-a-1@placeholder.local',
      'buyer-a-2@placeholder.local',
    ]);
  });

  it('merges into an existing customer by email', async () => {
    const { merchant, db } = setup();
    merchant.run(`INSERT INTO customers (id, email, name, order_count, total_spent_cents) VALUES ('c1', 'ann@example.com', 'Ann (web)', 2, 1000)`);
    await importOrders(db, fakeClient(ebayOrder({ buyer: { buyerRegistrationAddress: { email: 'ANN@example.com' } } })), 'ch1');

    expect(merchant.query<any>(`SELECT id, name, order_count, total_spent_cents FROM customers`)).toEqual([
      { id: 'c1', name: 'Ann (web)', order_count: 3, total_spent_cents: 5768 },
    ]);
    expect(merchant.query<any>(`SELECT customer_id FROM orders`)[0].customer_id).toBe('c1');
  });

  it('skips unpaid and cancelled orders without recording them, so a paid one imports later', async () => {
    const { merchant, db } = setup();
    const first = await importOrders(
      db,
      fakeClient(ebayOrder({ orderId: 'U-1', orderPaymentStatus: 'PENDING' }), ebayOrder({ orderId: 'C-1', cancelStatus: { cancelState: 'CANCELED' } })),
      'ch1'
    );
    expect(first.skipped).toEqual([
      { externalOrderId: 'U-1', reason: 'unpaid' },
      { externalOrderId: 'C-1', reason: 'cancelled' },
    ]);
    expect(count(merchant, 'marketplace_orders')).toBe(0);
    expect(stock(merchant).on_hand).toBe(10);

    const later = await importOrders(db, fakeClient(ebayOrder({ orderId: 'U-1', orderPaymentStatus: 'PAID' })), 'ch1');
    expect(later.imported.map((i) => i.externalOrderId)).toEqual(['U-1']);
  });

  it('marks an order already fulfilled on eBay as shipped', async () => {
    const { merchant, db } = setup();
    await importOrders(db, fakeClient(ebayOrder({ orderFulfillmentStatus: 'FULFILLED' })), 'ch1');
    expect(merchant.query<any>(`SELECT status FROM orders`)[0].status).toBe('shipped');
  });

  it('when oversold, imports the order, deducts what is available, and reports the shortfall', async () => {
    const { merchant, db } = setup();
    merchant.run(`UPDATE inventory SET on_hand = 4, reserved = 2 WHERE sku = 'TEE-RED-M'`); // 2 available
    const order = ebayOrder({
      lineItems: [{ lineItemId: 'LI-1', sku: 'TEE-RED-M', title: 'Red tee', quantity: 5, lineItemCost: { value: '99.95', currency: 'USD' } }],
    });
    const result = await importOrders(db, fakeClient(order), 'ch1');

    expect(result.imported).toHaveLength(1);
    expect(result.shortfalls).toEqual([{ externalOrderId: '12-34567-89012', sku: 'TEE-RED-M', ordered: 5, deducted: 2 }]);
    // Other carts' reservations survive: available drops to 0, never below.
    expect(stock(merchant)).toEqual({ on_hand: 2, reserved: 2 });
    expect(merchant.query<any>(`SELECT inventory_deducted FROM marketplace_order_lines`)[0].inventory_deducted).toBe(2);
  });

  it('imports lines with unknown SKUs but deducts nothing for them', async () => {
    const { merchant, db } = setup();
    const result = await importOrders(
      db,
      fakeClient(ebayOrder({ lineItems: [{ lineItemId: 'LI-9', sku: 'NOT-OURS', title: 'Mystery', quantity: 1, lineItemCost: { value: '5.00', currency: 'USD' } }] })),
      'ch1'
    );
    expect(result.imported).toHaveLength(1);
    expect(result.unmatchedSkus).toEqual([{ externalOrderId: '12-34567-89012', sku: 'NOT-OURS' }]);
    expect(merchant.query<any>(`SELECT sku FROM order_items`)[0].sku).toBe('NOT-OURS');
    expect(stock(merchant)).toEqual({ on_hand: 10, reserved: 3 });
  });

  it('resolves marketplace SKUs through marketplace_product_mappings', async () => {
    const { merchant, db } = setup();
    merchant.run(
      `INSERT INTO marketplace_product_mappings (id, channel_id, variant_id, external_listing_id, external_sku) VALUES ('m1', 'ch1', 'v1', 'L-1', 'EBAY-TEE')`
    );
    const result = await importOrders(
      db,
      fakeClient(ebayOrder({ lineItems: [{ lineItemId: 'LI-1', sku: 'EBAY-TEE', title: 'Red tee', quantity: 1, lineItemCost: { value: '19.99', currency: 'USD' } }] })),
      'ch1'
    );
    expect(result.unmatchedSkus).toEqual([]);
    expect(merchant.query<any>(`SELECT sku FROM order_items`)[0].sku).toBe('TEE-RED-M');
    expect(stock(merchant).on_hand).toBe(9);
  });

  it('does not touch stock for digital variants', async () => {
    const { merchant, db } = setup();
    const result = await importOrders(
      db,
      fakeClient(ebayOrder({ lineItems: [{ lineItemId: 'LI-1', sku: 'EBOOK', title: 'E-book', quantity: 1, lineItemCost: { value: '5.00', currency: 'USD' } }] })),
      'ch1'
    );
    expect(result).toMatchObject({ shortfalls: [], unmatchedSkus: [] });
    expect(count(merchant, 'inventory_logs')).toBe(0);
  });

  it('rolls back a failed order completely so the next run retries it, and continues with the rest', async () => {
    const { merchant, db } = setup();
    // Force the orders INSERT to fail: the order number is already taken.
    merchant.run(`INSERT INTO orders (id, number, customer_email, subtotal_cents, tax_cents, total_cents) VALUES ('x', 'EBAY-BAD-1', 'x@x.test', 0, 0, 0)`);

    const result = await importOrders(db, fakeClient(ebayOrder({ orderId: 'BAD-1' }), ebayOrder({ orderId: 'OK-1' })), 'ch1');

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ externalOrderId: 'BAD-1', error: expect.stringMatching(/UNIQUE/) });
    expect(result.imported.map((i) => i.externalOrderId)).toEqual(['OK-1']);

    expect(merchant.query<any>(`SELECT external_order_id FROM marketplace_orders`)).toEqual([{ external_order_id: 'OK-1' }]);
    expect(count(merchant, 'orders')).toBe(2); // the blocker + OK-1
    expect(stock(merchant).on_hand).toBe(8); // only OK-1 deducted
  });

  it('passes the window to the client filtered by modification time', async () => {
    const { db } = setup();
    const seen: unknown[] = [];
    const client = {
      listOrders: async (p: unknown) => {
        seen.push(p);
        return [] as MarketOrder[];
      },
    };
    const from = new Date('2026-11-01T00:00:00.000Z');
    await importOrders(db, client, 'ch1', { from, limit: 10 });
    expect(seen).toEqual([{ from, to: undefined, limit: 10, by: 'modified' }]);
  });
});
