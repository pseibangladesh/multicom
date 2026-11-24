import { describe, it, expect, vi } from 'vitest';
import { EbayClient, EbayApiError, ebayAmountToCents, centsToEbayAmount, mapEbayOrder, type EbayOrder } from '../src/lib/marketplace/ebay';
import type { MarketProduct } from '../src/lib/marketplace/types';
import { resolveBuyerEmail } from '../src/lib/marketplace/buyer';

// ─── Fake eBay ───────────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | undefined;

function fakeEbay(...handlers: Handler[]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
    }
    return new Response(null, { status: 204 });
  });
  return { fetchMock, calls };
}

const on =
  (method: string, path: string | RegExp, res: { status?: number; body?: unknown }): Handler =>
  (c) =>
    c.method === method && (typeof path === 'string' ? c.url.pathname === path : path.test(c.url.pathname)) ? res : undefined;

function tokens(access = 'tok-1') {
  return { getAccessToken: vi.fn(async () => access), refresh: vi.fn(async () => 'tok-2') };
}

function client(handlers: Handler[], opts: Partial<ConstructorParameters<typeof EbayClient>[0]> = {}) {
  const ebay = fakeEbay(...handlers);
  const t = tokens();
  const c = new EbayClient({ tokens: t, fetch: ebay.fetchMock, channelId: 'ch1', ...opts });
  return { c, calls: ebay.calls, tokens: t };
}

const LISTING = {
  categoryId: '15687',
  fulfillmentPolicyId: 'fp',
  paymentPolicyId: 'pp',
  returnPolicyId: 'rp',
  merchantLocationKey: 'warehouse-1',
};

const product: MarketProduct = {
  id: 'var_1',
  sku: 'TEE-RED-M',
  title: 'Red tee',
  description: '<p>Soft</p>',
  priceCents: 1999,
  currency: 'USD',
  imageUrl: 'https://img.test/tee.jpg',
  quantity: 7,
  weightG: 180,
  requiresShipping: true,
  status: 'active',
};

// ─── Money & mapping ─────────────────────────────────────────────────────────

describe('money conversion', () => {
  it.each([
    ['19.99', 1999],
    ['0.1', 10],
    ['1000', 100000],
    ['0.29', 29], // 0.29 * 100 = 28.999… in floating point
    ['-5.50', -550],
  ])('%s → %d cents', (value, cents) => {
    expect(ebayAmountToCents({ value, currency: 'USD' })).toBe(cents);
  });

  it('formats cents for eBay', () => {
    expect(centsToEbayAmount(1999, 'USD')).toEqual({ value: '19.99', currency: 'USD' });
    expect(centsToEbayAmount(5, 'GBP')).toEqual({ value: '0.05', currency: 'GBP' });
  });
});

const ORDER: EbayOrder = {
  orderId: '12-34567-89012',
  creationDate: '2026-11-20T08:00:00.000Z',
  orderFulfillmentStatus: 'NOT_STARTED',
  buyer: { username: 'buyer1', buyerRegistrationAddress: { fullName: 'Ann Buyer', email: 'Ann@Example.com' } },
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
};

describe('mapEbayOrder', () => {
  it('maps eBay camelCase orders to MarketOrder', () => {
    expect(mapEbayOrder(ORDER, 'ch1')).toEqual({
      externalOrderId: '12-34567-89012',
      platform: 'ebay',
      channelStoreId: 'ch1',
      customerEmail: 'ann@example.com',
      items: [{ sku: 'TEE-RED-M', title: 'Red tee', qty: 2, unitPriceCents: 1999, externalLineItemId: 'LI-1' }],
      subtotalCents: 3998,
      taxCents: 320,
      shippingCents: 450,
      totalCents: 4768,
      currency: 'USD',
      status: 'NOT_STARTED',
      cancelled: false,
      shippingAddress: {
        name: 'Ann Buyer',
        line1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
        phone: '555-0100',
      },
      createdAt: '2026-11-20T08:00:00.000Z',
    });
  });

  it('carries payment and cancellation state', () => {
    const o = mapEbayOrder({ ...ORDER, orderPaymentStatus: 'PAID', cancelStatus: { cancelState: 'CANCELED' } });
    expect(o.paymentStatus).toBe('PAID');
    expect(o.cancelled).toBe(true);
  });

  it('uses the per-order placeholder email when the buyer email is missing', () => {
    const { buyer: _b, ...noBuyer } = ORDER;
    expect(mapEbayOrder(noBuyer).customerEmail).toBe('buyer-12-34567-89012@placeholder.local');
  });
});

describe('resolveBuyerEmail', () => {
  it('replaces masked marketplace relays and invalid values with a placeholder', () => {
    expect(resolveBuyerEmail('xyz123@marketplace.amazon.com', '111-222')).toBe('buyer-111-222@placeholder.local');
    expect(resolveBuyerEmail('not-an-email', 'A/B')).toBe('buyer-a-b@placeholder.local');
    expect(resolveBuyerEmail(undefined, 'X1')).toBe('buyer-x1@placeholder.local');
    expect(resolveBuyerEmail(' Real@Shop.com ', 'X1')).toBe('real@shop.com');
  });
});

// ─── Requests ────────────────────────────────────────────────────────────────

describe('EbayClient requests', () => {
  it('sends bearer token and marketplace header to the right host', async () => {
    const { c, calls } = client([on('GET', '/sell/inventory/v1/inventory_item', { body: { inventoryItems: [] } })], {
      environment: 'sandbox',
      marketplaceId: 'EBAY_GB',
    });
    await c.listProducts();
    expect(calls[0].url.origin).toBe('https://api.sandbox.ebay.com');
    expect(calls[0].headers.Authorization).toBe('Bearer tok-1');
    expect(calls[0].headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_GB');
  });

  it('refreshes once and retries on 401', async () => {
    let first = true;
    const { c, calls, tokens: t } = client([
      (call) => {
        if (first) {
          first = false;
          return { status: 401, body: { errors: [{ errorId: 1001, message: 'Invalid access token' }] } };
        }
        return call.url.pathname === '/sell/inventory/v1/inventory_item' ? { body: { inventoryItems: [] } } : undefined;
      },
    ]);
    await c.listProducts();
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(calls.map((x) => x.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('surfaces eBay error messages in EbayApiError', async () => {
    const { c } = client([on('GET', /\/inventory_item\//, { status: 400, body: { errors: [{ errorId: 25709, message: 'Invalid SKU' }] } })]);
    const err = await c.getProduct('bad sku').catch((e) => e);
    expect(err).toBeInstanceOf(EbayApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Invalid SKU');
  });

  it('honours the local rate limiter', async () => {
    const { c, calls } = client([], { rateLimiter: { acquire: async () => false } });
    await expect(c.listProducts()).rejects.toThrow(/rate limit/);
    expect(calls).toHaveLength(0);
  });
});

describe('EbayClient products', () => {
  it('upsert without listing config only writes the inventory item, keyed by SKU', async () => {
    const { c, calls } = client([]);
    expect(await c.upsertProduct(product)).toBe('TEE-RED-M');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url.pathname).toBe('/sell/inventory/v1/inventory_item/TEE-RED-M');
    expect(calls[0].headers['Content-Language']).toBe('en-US');
    expect(calls[0].body).toEqual({
      condition: 'NEW',
      availability: { shipToLocationAvailability: { quantity: 7 } },
      product: { title: 'Red tee', description: '<p>Soft</p>', imageUrls: ['https://img.test/tee.jpg'] },
      packageWeightAndSize: { weight: { value: 180, unit: 'GRAM' } },
    });
  });

  it('URL-encodes SKUs in paths', async () => {
    const { c, calls } = client([]);
    await c.deleteProduct('A/B C');
    expect(calls[0].url.pathname).toBe('/sell/inventory/v1/inventory_item/A%2FB%20C');
  });

  it('with listing config, creates the offer and publishes it for an active product', async () => {
    const { c, calls } = client(
      [
        on('GET', '/sell/inventory/v1/offer', { status: 404, body: { errors: [{ errorId: 25713 }] } }),
        on('POST', '/sell/inventory/v1/offer', { status: 201, body: { offerId: 'OFF-1' } }),
        on('POST', '/sell/inventory/v1/offer/OFF-1/publish', { body: { listingId: '1100' } }),
      ],
      { listing: LISTING }
    );
    await c.upsertProduct(product);

    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      'PUT /sell/inventory/v1/inventory_item/TEE-RED-M',
      'GET /sell/inventory/v1/offer',
      'POST /sell/inventory/v1/offer',
      'POST /sell/inventory/v1/offer/OFF-1/publish',
    ]);
    expect(calls[1].url.searchParams.get('sku')).toBe('TEE-RED-M');
    expect(calls[2].body).toMatchObject({
      sku: 'TEE-RED-M',
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      availableQuantity: 7,
      categoryId: '15687',
      merchantLocationKey: 'warehouse-1',
      listingPolicies: { fulfillmentPolicyId: 'fp', paymentPolicyId: 'pp', returnPolicyId: 'rp' },
      pricingSummary: { price: { value: '19.99', currency: 'USD' } },
    });
  });

  it('updates an existing published offer in place without re-publishing', async () => {
    const { c, calls } = client(
      [on('GET', '/sell/inventory/v1/offer', { body: { offers: [{ offerId: 'OFF-9', sku: 'TEE-RED-M', marketplaceId: 'EBAY_US', status: 'PUBLISHED' }] } })],
      { listing: LISTING }
    );
    await c.upsertProduct({ ...product, priceCents: 2500 });
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      'PUT /sell/inventory/v1/inventory_item/TEE-RED-M',
      'GET /sell/inventory/v1/offer',
      'PUT /sell/inventory/v1/offer/OFF-9',
    ]);
    expect(calls[2].body.pricingSummary.price.value).toBe('25.00');
  });

  it('withdraws the published listing when the product is no longer active', async () => {
    const { c, calls } = client(
      [on('GET', '/sell/inventory/v1/offer', { body: { offers: [{ offerId: 'OFF-9', sku: 'TEE-RED-M', marketplaceId: 'EBAY_US', status: 'PUBLISHED' }] } })],
      { listing: LISTING }
    );
    await c.upsertProduct({ ...product, status: 'draft' });
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      'PUT /sell/inventory/v1/inventory_item/TEE-RED-M',
      'GET /sell/inventory/v1/offer',
      'PUT /sell/inventory/v1/offer/OFF-9',
      'POST /sell/inventory/v1/offer/OFF-9/withdraw',
    ]);
  });

  it('republishes a withdrawn offer when the product becomes active again', async () => {
    const { c, calls } = client(
      [on('GET', '/sell/inventory/v1/offer', { body: { offers: [{ offerId: 'OFF-9', sku: 'TEE-RED-M', marketplaceId: 'EBAY_US', status: 'UNPUBLISHED' }] } })],
      { listing: LISTING }
    );
    await c.upsertProduct(product);
    expect(calls.at(-1)!.url.pathname).toBe('/sell/inventory/v1/offer/OFF-9/publish');
  });

  it('does nothing extra for an inactive product that was never published', async () => {
    const { c, calls } = client(
      [on('GET', '/sell/inventory/v1/offer', { body: { offers: [{ offerId: 'OFF-9', sku: 'TEE-RED-M', marketplaceId: 'EBAY_US', status: 'UNPUBLISHED' }] } })],
      { listing: LISTING }
    );
    await c.upsertProduct({ ...product, status: 'inactive' });
    expect(calls.some((x) => /publish|withdraw/.test(x.url.pathname))).toBe(false);
  });

  it('filters listOrders on lastmodifieddate when asked', async () => {
    const { c, calls } = client([on('GET', '/sell/fulfillment/v1/order', { body: { orders: [] } })]);
    await c.listOrders({ from: new Date('2026-11-01T00:00:00.000Z'), by: 'modified' });
    expect(calls[0].url.searchParams.get('filter')).toBe('lastmodifieddate:[2026-11-01T00:00:00.000Z..]');
  });

  it('getProduct combines the inventory item with its offer price and status', async () => {
    const { c } = client([
      on('GET', '/sell/inventory/v1/inventory_item/TEE-RED-M', {
        body: {
          product: { title: 'Red tee', description: 'd', imageUrls: ['https://img.test/a.jpg'] },
          availability: { shipToLocationAvailability: { quantity: 3 } },
          packageWeightAndSize: { weight: { value: 1, unit: 'KILOGRAM' } },
        },
      }),
      on('GET', '/sell/inventory/v1/offer', {
        body: { offers: [{ offerId: 'O', sku: 'TEE-RED-M', marketplaceId: 'EBAY_US', status: 'PUBLISHED', pricingSummary: { price: { value: '12.50', currency: 'USD' } } }] },
      }),
    ]);
    expect(await c.getProduct('TEE-RED-M')).toMatchObject({
      sku: 'TEE-RED-M',
      priceCents: 1250,
      quantity: 3,
      weightG: 1000,
      imageUrl: 'https://img.test/a.jpg',
      status: 'active',
    });
  });

  it('listProducts pages by offset cursor', async () => {
    const { c, calls } = client([
      on('GET', '/sell/inventory/v1/inventory_item', { body: { inventoryItems: [{ sku: 'A' }, { sku: 'B' }], next: 'more' } }),
    ]);
    const page = await c.listProducts({ limit: 2, cursor: '4' });
    expect(calls[0].url.searchParams.get('offset')).toBe('4');
    expect(page.items.map((p) => p.sku)).toEqual(['A', 'B']);
    expect(page.nextCursor).toBe('6');
  });
});

describe('EbayClient inventory', () => {
  it('updates quantity via bulk_update_price_quantity (not a full item PUT)', async () => {
    const { c, calls } = client([
      on('POST', '/sell/inventory/v1/bulk_update_price_quantity', { body: { responses: [{ sku: 'TEE-RED-M', statusCode: 200 }] } }),
    ]);
    await c.updateInventory('TEE-RED-M', 4);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ requests: [{ sku: 'TEE-RED-M', shipToLocationAvailability: { quantity: 4 } }] });
  });

  it('throws when eBay rejects the SKU inside a 200 bulk response', async () => {
    const { c } = client([
      on('POST', '/sell/inventory/v1/bulk_update_price_quantity', {
        body: { responses: [{ sku: 'NOPE', statusCode: 404, errors: [{ message: 'SKU not found' }] }] },
      }),
    ]);
    await expect(c.updateInventory('NOPE', 1)).rejects.toThrow(/SKU not found/);
  });

  it('clamps negative stock to zero', async () => {
    const { c, calls } = client([on('POST', '/sell/inventory/v1/bulk_update_price_quantity', { body: { responses: [] } })]);
    await c.updateInventory('X', -3);
    expect(calls[0].body.requests[0].shipToLocationAvailability.quantity).toBe(0);
  });
});

describe('EbayClient orders', () => {
  it('filters by creation date and follows pagination', async () => {
    let page = 0;
    const { c, calls } = client([
      (call) =>
        call.url.pathname === '/sell/fulfillment/v1/order'
          ? page++ === 0
            ? { body: { orders: [ORDER], next: 'n' } }
            : { body: { orders: [{ ...ORDER, orderId: 'second' }] } }
          : undefined,
    ]);
    const orders = await c.listOrders({ from: new Date('2026-11-01T00:00:00.000Z') });

    expect(calls[0].url.searchParams.get('filter')).toBe('creationdate:[2026-11-01T00:00:00.000Z..]');
    expect(calls.map((x) => x.url.searchParams.get('offset'))).toEqual(['0', '1']);
    expect(orders.map((o) => o.externalOrderId)).toEqual(['12-34567-89012', 'second']);
  });

  it('updateShipment ships every line of the order at full quantity', async () => {
    const { c, calls } = client(
      [
        on('GET', '/sell/fulfillment/v1/order/12-34567-89012', { body: ORDER }),
        on('POST', '/sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment', { status: 201 }),
      ],
      { defaultShippingCarrierCode: 'USPS' }
    );
    await c.updateShipment('12-34567-89012', '9400100000000000000000');
    expect(calls[1].body).toMatchObject({
      lineItems: [{ lineItemId: 'LI-1', quantity: 2 }],
      shippingCarrierCode: 'USPS',
      trackingNumber: '9400100000000000000000',
    });
    expect(typeof calls[1].body.shippedDate).toBe('string');
  });

  it('createShippingFulfillment can ship a subset of lines without fetching the order', async () => {
    const { c, calls } = client([]);
    await c.createShippingFulfillment({
      orderId: 'O-1',
      trackingNumber: 'T',
      shippingCarrierCode: 'UPS',
      lineItems: [{ lineItemId: 'LI-2', quantity: 1 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/sell/fulfillment/v1/order/O-1/shipping_fulfillment');
  });

  it('updateShipment refuses to guess a carrier', async () => {
    const { c, calls } = client([]);
    await expect(c.updateShipment('O-1', 'T')).rejects.toThrow(/defaultShippingCarrierCode/);
    expect(calls).toHaveLength(0);
  });
});

describe('EbayClient health', () => {
  it('is true when the Inventory API answers and false otherwise', async () => {
    expect(await client([on('GET', '/sell/inventory/v1/inventory_item', { body: {} })]).c.healthCheck()).toBe(true);
    expect(await client([() => ({ status: 500 })]).c.healthCheck()).toBe(false);
  });
});
