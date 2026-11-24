import { describe, it, expect, vi } from 'vitest';
import {
  EtsyClient,
  EtsyApiError,
  mapEtsyReceipt,
  mapEtsyListing,
  inventoryWriteBody,
  etsyMoneyToCents,
  type EtsyReceipt,
  type EtsyListing,
  type EtsyInventory,
  type EtsyListingDefaults,
} from '../src/lib/marketplace/etsy';

const usd = (amount: number) => ({ amount, divisor: 100, currency_code: 'USD' });

const RECEIPT: EtsyReceipt = {
  receipt_id: 3456789012,
  status: 'Paid',
  is_paid: true,
  is_shipped: false,
  buyer_email: 'Ana@Example.com',
  name: 'Ana Buyer',
  first_line: '1 Main St',
  second_line: 'Apt 2',
  city: 'Portland',
  state: 'OR',
  zip: '97201',
  country_iso: 'US',
  created_timestamp: 1763805600, // 2025-11-22T10:00:00Z
  subtotal: usd(3500),
  grandtotal: usd(4380),
  total_shipping_cost: usd(500),
  total_tax_cost: usd(300),
  total_vat_cost: usd(80),
  transactions: [
    { transaction_id: 111, title: 'Mug', quantity: 2, price: usd(1250), sku: 'MUG-1' },
    { transaction_id: 222, title: 'Card', quantity: 1, price: usd(1000), sku: null },
  ],
};

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

/** Routes "METHOD /path" (path relative to /v3/application) to a handler. */
function fakeEtsy(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(call);
    const key = `${call.method} ${url.pathname.replace('/v3/application', '')}`;
    const handler = routes[key] ?? routes[`${call.method} ${url.origin}${url.pathname}`];
    if (!handler) return Response.json({ error: `unexpected ${key}` }, { status: 500 });
    return handler(call);
  });
  return { fetchMock, calls };
}

function client(fetchMock: typeof fetch, opts: { listing?: EtsyListingDefaults; tokens?: { getAccessToken(): Promise<string>; refresh(): Promise<string> } } = {}) {
  return new EtsyClient({
    tokens: opts.tokens ?? { getAccessToken: async () => '123.tok', refresh: async () => '123.tok2' },
    apiKey: 'key:secret',
    shopId: '999',
    channelId: 'ch1',
    listing: opts.listing,
    fetch: fetchMock,
  });
}

const form = (body: BodyInit | null | undefined) => Object.fromEntries(new URLSearchParams(String(body)));
const json = (body: BodyInit | null | undefined) => JSON.parse(String(body));

describe('money', () => {
  it('converts amount/divisor to cents', () => {
    expect(etsyMoneyToCents(usd(1234))).toBe(1234);
    expect(etsyMoneyToCents({ amount: 1234, divisor: 1000, currency_code: 'KWD' })).toBe(123);
    expect(etsyMoneyToCents({ amount: 5, divisor: 0, currency_code: 'USD' })).toBe(0);
    expect(etsyMoneyToCents(undefined)).toBe(0);
  });
});

describe('mapEtsyReceipt', () => {
  it('maps totals, lines, buyer and address', () => {
    expect(mapEtsyReceipt(RECEIPT, 'ch1')).toEqual({
      externalOrderId: '3456789012',
      platform: 'etsy',
      channelStoreId: 'ch1',
      customerEmail: 'ana@example.com',
      items: [
        { sku: 'MUG-1', title: 'Mug', qty: 2, unitPriceCents: 1250, externalLineItemId: '111' },
        { sku: '', title: 'Card', qty: 1, unitPriceCents: 1000, externalLineItemId: '222' },
      ],
      subtotalCents: 3500,
      taxCents: 380, // sales tax + VAT
      shippingCents: 500,
      totalCents: 4380,
      currency: 'USD',
      status: 'NOT_STARTED',
      paymentStatus: 'PAID',
      cancelled: false,
      shippingAddress: { name: 'Ana Buyer', line1: '1 Main St', line2: 'Apt 2', city: 'Portland', state: 'OR', postalCode: '97201', country: 'US' },
      createdAt: '2025-11-22T10:00:00.000Z',
    });
  });

  it('normalizes status into what order import understands', () => {
    expect(mapEtsyReceipt({ ...RECEIPT, is_shipped: true }).status).toBe('FULFILLED');
    expect(mapEtsyReceipt({ ...RECEIPT, status: 'Completed' }).status).toBe('FULFILLED');
    expect(mapEtsyReceipt({ ...RECEIPT, status: 'Canceled' }).cancelled).toBe(true);
    expect(mapEtsyReceipt({ ...RECEIPT, status: 'Payment Processing', is_paid: false }).paymentStatus).toBe('PENDING');
    expect(mapEtsyReceipt({ ...RECEIPT, status: 'Fully Refunded' }).paymentStatus).toBe('FULLY_REFUNDED');
    expect(mapEtsyReceipt({ ...RECEIPT, status: 'Partially Refunded' }).paymentStatus).toBe('PARTIALLY_REFUNDED');
  });

  it('uses a placeholder email when Etsy withholds the buyer email', () => {
    expect(mapEtsyReceipt({ ...RECEIPT, buyer_email: null }).customerEmail).toBe('buyer-3456789012@placeholder.local');
  });

  it('falls back to summing lines when Etsy omits totals', () => {
    const m = mapEtsyReceipt({ receipt_id: 1, transactions: RECEIPT.transactions });
    expect(m.subtotalCents).toBe(3500);
    expect(m.totalCents).toBe(3500);
    expect(m.shippingAddress).toBeUndefined();
  });
});

describe('mapEtsyListing', () => {
  it('returns one product per live variant', () => {
    const listing: EtsyListing = {
      listing_id: 42,
      title: 'Mug',
      state: 'active',
      item_weight: 10,
      item_weight_unit: 'oz',
      images: [{ url_fullxfull: 'https://img/1.jpg' }],
      inventory: {
        products: [
          { sku: 'MUG-S', property_values: [], offerings: [{ price: usd(1200), quantity: 3, is_enabled: true }] },
          { sku: 'MUG-L', property_values: [], offerings: [{ price: usd(1500), quantity: 9, is_enabled: false }] },
          { sku: 'OLD', is_deleted: true, property_values: [], offerings: [{ price: usd(1), quantity: 1, is_enabled: true }] },
        ],
      },
    };
    const out = mapEtsyListing(listing);
    expect(out.map((p) => [p.id, p.sku, p.priceCents, p.quantity, p.status])).toEqual([
      ['42', 'MUG-S', 1200, 3, 'active'],
      ['42', 'MUG-L', 1500, 0, 'active'], // disabled offering = not sellable
    ]);
    expect(out[0].weightG).toBe(283);
    expect(out[0].imageUrl).toBe('https://img/1.jpg');
  });
});

describe('inventoryWriteBody', () => {
  it('strips read-only fields, converts prices, and patches only the matching SKU', () => {
    const inv: EtsyInventory = {
      products: [
        {
          product_id: 1,
          sku: 'A',
          property_values: [{ property_id: 200, property_name: 'Color', scale_id: null, value_ids: [1], values: ['Red'] }],
          offerings: [{ offering_id: 9, price: usd(1000), quantity: 4, is_enabled: true, is_deleted: false }],
        },
        { product_id: 2, sku: 'B', property_values: [], offerings: [{ offering_id: 10, price: usd(1500), quantity: 7, is_enabled: true }] },
      ],
      price_on_property: [200],
      quantity_on_property: [200],
      sku_on_property: [200],
    };
    expect(inventoryWriteBody(inv, { sku: 'B', quantity: 2 })).toEqual({
      products: [
        {
          sku: 'A',
          property_values: [{ property_id: 200, property_name: 'Color', value_ids: [1], values: ['Red'] }],
          offerings: [{ price: 10, quantity: 4, is_enabled: true }],
        },
        { sku: 'B', property_values: [], offerings: [{ price: 15, quantity: 2, is_enabled: true }] },
      ],
      price_on_property: [200],
      quantity_on_property: [200],
      sku_on_property: [200],
    });
  });
});

describe('EtsyClient HTTP', () => {
  it('sends Bearer + x-api-key and retries once after a 401 with a refreshed token', async () => {
    const tokens = { getAccessToken: vi.fn(async () => 'stale'), refresh: vi.fn(async () => 'fresh') };
    let n = 0;
    const { fetchMock, calls } = fakeEtsy({
      'GET /shops/999': () => (n++ === 0 ? Response.json({ error: 'invalid_token' }, { status: 401 }) : Response.json({ shop_id: 999 })),
    });
    expect(await client(fetchMock, { tokens }).healthCheck()).toBe(true);
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh']);
    expect(calls[0].headers['x-api-key']).toBe('key:secret');
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces Etsy errors as EtsyApiError', async () => {
    const { fetchMock } = fakeEtsy({ 'GET /shops/999/receipts/1': () => Response.json({ error: 'Receipt not found' }, { status: 404 }) });
    const err = await client(fetchMock).getOrder('1').catch((e) => e);
    expect(err).toBeInstanceOf(EtsyApiError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/Receipt not found/);
  });

  it('honours the local rate limiter', async () => {
    const { fetchMock } = fakeEtsy({});
    const c = new EtsyClient({
      tokens: { getAccessToken: async () => 't', refresh: async () => 't' },
      apiKey: 'k:s',
      shopId: '999',
      rateLimiter: { acquire: async () => false },
      fetch: fetchMock,
    });
    await expect(c.getOrder('1')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('EtsyClient.listOrders', () => {
  it('filters on last-modified epoch seconds and pages by offset until count', async () => {
    const page = (ids: number[]) => ids.map((id) => ({ ...RECEIPT, receipt_id: id }));
    const { fetchMock, calls } = fakeEtsy({
      'GET /shops/999/receipts': (c) =>
        Response.json({ count: 3, results: c.url.searchParams.get('offset') === '0' ? page([1, 2]) : page([3]) }),
    });
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-11-02T00:00:00Z');
    const orders = await client(fetchMock).listOrders({ from, to, by: 'modified' });

    expect(orders.map((o) => o.externalOrderId)).toEqual(['1', '2', '3']);
    expect(orders[0].channelStoreId).toBe('ch1');
    expect(calls).toHaveLength(2);
    const q = calls[0].url.searchParams;
    expect(q.get('min_last_modified')).toBe(String(from.getTime() / 1000));
    expect(q.get('max_last_modified')).toBe(String(to.getTime() / 1000));
    expect(q.has('min_created')).toBe(false);
    expect(calls[1].url.searchParams.get('offset')).toBe('2');
  });

  it('defaults to the created window and respects limit', async () => {
    const { fetchMock, calls } = fakeEtsy({ 'GET /shops/999/receipts': () => Response.json({ count: 500, results: [RECEIPT] }) });
    await client(fetchMock).listOrders({ from: new Date(0), limit: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('min_created')).toBe('0');
    expect(calls[0].url.searchParams.get('limit')).toBe('1');
  });
});

describe('EtsyClient shipments', () => {
  it('posts tracking for the receipt with a lower-cased carrier', async () => {
    const { fetchMock, calls } = fakeEtsy({ 'POST /shops/999/receipts/777/tracking': () => Response.json({ receipt_id: 777 }) });
    await client(fetchMock).createShippingFulfillment({
      orderId: '777',
      trackingNumber: '1Z999',
      shippingCarrierCode: 'UPS',
      lineItems: [{ lineItemId: '111', quantity: 1 }],
    });
    expect(form(calls[0].body)).toEqual({ tracking_code: '1Z999', carrier_name: 'ups' });
  });

  it('updateShipment uses the "other" carrier when none is configured', async () => {
    const { fetchMock, calls } = fakeEtsy({ 'POST /shops/999/receipts/777/tracking': () => Response.json({}) });
    await client(fetchMock).updateShipment('777', 'TRK');
    expect(form(calls[0].body).carrier_name).toBe('other');
  });
});

// ─── Listings ────────────────────────────────────────────────────────────────

const DEFAULTS: EtsyListingDefaults = { taxonomyId: 1027, shippingProfileId: 555, readinessStateId: 66 };

const PRODUCT = {
  id: 'v1',
  sku: 'MUG-1',
  title: 'Mug',
  description: 'A mug',
  priceCents: 1999,
  currency: 'USD',
  imageUrl: 'https://cdn.test/mug.jpg',
  quantity: 0,
  weightG: 350,
  requiresShipping: true,
  status: 'active' as const,
};

/** Empty shop for every state, so the SKU scan finds nothing. */
const emptyShop = { 'GET /shops/999/listings': () => Response.json({ count: 0, results: [] }) };

describe('EtsyClient.upsertProduct (new listing)', () => {
  it('refuses to create a listing without channel listing defaults', async () => {
    const { fetchMock, calls } = fakeEtsy(emptyShop);
    await expect(client(fetchMock).upsertProduct(PRODUCT)).rejects.toThrow(/listing defaults/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates a draft, sets SKU + stock, uploads the photo, then activates', async () => {
    const { fetchMock, calls } = fakeEtsy({
      ...emptyShop,
      'POST /shops/999/listings': () => Response.json({ listing_id: 42 }, { status: 201 }),
      'PUT /listings/42/inventory': () => Response.json({ products: [] }),
      'GET https://cdn.test/mug.jpg': () => new Response(new Blob(['img'], { type: 'image/jpeg' })),
      'POST /shops/999/listings/42/images': () => Response.json({ listing_image_id: 1 }, { status: 201 }),
      'PATCH /shops/999/listings/42': () => Response.json({ listing_id: 42, state: 'active' }),
    });

    expect(await client(fetchMock, { listing: DEFAULTS }).upsertProduct(PRODUCT)).toBe('42');

    // The SKU scan walked all five listing states.
    expect(calls.filter((c) => c.url.pathname.endsWith('/shops/999/listings') && c.method === 'GET').map((c) => c.url.searchParams.get('state'))).toEqual([
      'active',
      'draft',
      'inactive',
      'sold_out',
      'expired',
    ]);

    const create = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/listings'))!;
    expect(form(create.body)).toMatchObject({
      quantity: '1', // Etsy rejects 0 on create
      title: 'Mug',
      price: '19.99',
      taxonomy_id: '1027',
      shipping_profile_id: '555',
      readiness_state_id: '66',
      who_made: 'i_did',
      when_made: 'made_to_order',
      is_supply: 'false',
      type: 'physical',
      item_weight: '350',
      item_weight_unit: 'g',
    });

    const inv = calls.find((c) => c.method === 'PUT')!;
    expect(json(inv.body)).toEqual({ products: [{ sku: 'MUG-1', property_values: [], offerings: [{ price: 19.99, quantity: 0, is_enabled: true }] }] });

    const upload = calls.find((c) => c.url.pathname.endsWith('/images'))!;
    expect(upload.body).toBeInstanceOf(FormData);
    expect((upload.body as FormData).get('image')).toBeInstanceOf(Blob);

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(form(patch.body)).toEqual({ state: 'active' });
  });

  it('leaves a listing without a photo as a draft', async () => {
    const { fetchMock, calls } = fakeEtsy({
      ...emptyShop,
      'POST /shops/999/listings': () => Response.json({ listing_id: 43 }),
      'PUT /listings/43/inventory': () => Response.json({}),
    });
    await client(fetchMock, { listing: DEFAULTS }).upsertProduct({ ...PRODUCT, imageUrl: null });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('EtsyClient.upsertProduct / updateInventory (existing listing)', () => {
  const multiVariant: EtsyListing = {
    listing_id: 77,
    title: 'Mug set',
    state: 'inactive',
    skus: ['MUG-1', 'MUG-2'],
    inventory: {
      products: [
        { sku: 'MUG-1', property_values: [], offerings: [{ price: usd(1000), quantity: 1, is_enabled: true }] },
        { sku: 'MUG-2', property_values: [], offerings: [{ price: usd(2000), quantity: 5, is_enabled: true }] },
      ],
    },
  };

  function shopWith(listing: EtsyListing) {
    return fakeEtsy({
      'GET /shops/999/listings': (c) => Response.json(c.url.searchParams.get('state') === listing.state ? { count: 1, results: [listing] } : { count: 0, results: [] }),
      [`GET /listings/${listing.listing_id}`]: () => Response.json(listing),
      [`GET /listings/${listing.listing_id}/inventory`]: () => Response.json(listing.inventory),
      [`PUT /listings/${listing.listing_id}/inventory`]: () => Response.json({}),
      [`PATCH /shops/999/listings/${listing.listing_id}`]: () => Response.json({}),
    });
  }

  it('updates only its own variant and leaves shared title/description alone', async () => {
    const { fetchMock, calls } = shopWith(multiVariant);
    expect(await client(fetchMock).upsertProduct({ ...PRODUCT, priceCents: 1250, quantity: 8 })).toBe('77');

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(form(patch.body)).toEqual({ state: 'active' }); // no title/description: listing has 2 variants
    const put = json(calls.find((c) => c.method === 'PUT')!.body);
    expect(put.products.map((p: any) => [p.sku, p.offerings[0].price, p.offerings[0].quantity])).toEqual([
      ['MUG-1', 12.5, 8],
      ['MUG-2', 20, 5],
    ]);
  });

  it('rewrites title/description on a single-variant listing and deactivates it', async () => {
    const single: EtsyListing = { ...multiVariant, state: 'active', inventory: { products: [multiVariant.inventory!.products[0]] } };
    const { fetchMock, calls } = shopWith(single);
    await client(fetchMock).upsertProduct({ ...PRODUCT, title: 'New mug', status: 'inactive' });
    expect(form(calls.find((c) => c.method === 'PATCH')!.body)).toEqual({ title: 'New mug', description: 'A mug', state: 'inactive' });
  });

  it('does not reactivate expired listings (that would renew and bill the seller)', async () => {
    const { fetchMock, calls } = shopWith({ ...multiVariant, state: 'expired' });
    await client(fetchMock).upsertProduct(PRODUCT);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('updateInventory changes only the quantity of the matching SKU, reusing the SKU index', async () => {
    const { fetchMock, calls } = shopWith(multiVariant);
    const c = client(fetchMock);
    await c.updateInventory('MUG-2', 0);
    await c.updateInventory('MUG-1', 3);

    const puts = calls.filter((x) => x.method === 'PUT').map((x) => json(x.body).products.map((p: any) => [p.sku, p.offerings[0].price, p.offerings[0].quantity]));
    expect(puts[0]).toEqual([
      ['MUG-1', 10, 1],
      ['MUG-2', 20, 0],
    ]);
    expect(puts[1][0]).toEqual(['MUG-1', 10, 3]);
    // One full scan (5 states) for both updates.
    expect(calls.filter((x) => x.url.pathname.endsWith('/shops/999/listings')).length).toBe(5);
  });

  it('updateInventory fails clearly for an unknown SKU', async () => {
    const { fetchMock } = shopWith(multiVariant);
    await expect(client(fetchMock).updateInventory('NOPE', 1)).rejects.toMatchObject({ status: 404 });
  });

  it('deleteProduct tolerates an already-deleted listing', async () => {
    const { fetchMock } = fakeEtsy({ 'DELETE /listings/77': () => Response.json({ error: 'gone' }, { status: 404 }) });
    await expect(client(fetchMock).deleteProduct('77')).resolves.toBeUndefined();
  });
});

describe('EtsyClient.listProducts', () => {
  it('walks states with a "<state>:<offset>" cursor', async () => {
    const listing: EtsyListing = { listing_id: 5, state: 'active', skus: ['A'], quantity: 2, price: usd(500) };
    const { fetchMock } = fakeEtsy({
      'GET /shops/999/listings': (c) =>
        Response.json(
          c.url.searchParams.get('state') === 'active'
            ? { count: 2, results: [listing] } // count says one more page in this state
            : { count: 0, results: [] }
        ),
    });
    const c = client(fetchMock);
    const first = await c.listProducts({ limit: 1 });
    expect(first.items.map((p) => [p.id, p.sku, p.priceCents, p.quantity])).toEqual([['5', 'A', 500, 2]]);
    expect(first.nextCursor).toBe('0:1');
    expect((await c.listProducts({ cursor: '1:0' })).nextCursor).toBe('2:0');
    expect((await c.listProducts({ cursor: '4:0' })).nextCursor).toBeUndefined();
  });
});
