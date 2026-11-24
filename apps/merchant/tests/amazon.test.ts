/**
 * Amazon SP-API connector: seller authorization, LWA tokens, the client
 * (listings, inventory, orders with RDT, shipment confirmation) and the
 * connect routes. SP-API and LWA are faked at the fetch level.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  AmazonClient,
  AmazonApiError,
  amazonCarrier,
  barcodeType,
  mapAmazonListing,
  mapAmazonOrder,
  pickMarketplace,
  type AmazonOrderItemWire,
  type AmazonOrderWire,
} from '../src/lib/marketplace/amazon';
import {
  AmazonTokenManager,
  amazonAppFromEnv,
  buildAmazonAuthorizeUrl,
  exchangeAmazonCode,
  isAmazonCallbackUri,
} from '../src/lib/marketplace/amazon-oauth';
import { amazonClientForChannel, loadChannel } from '../src/lib/marketplace/channel';
import { CredentialManager } from '../src/lib/marketplace/auth-manager';
import { importOrders } from '../src/lib/marketplace/order-import';
import { isRetryable } from '../src/lib/marketplace/sync-jobs';
import { marketplaceRoutes } from '../src/routes/marketplace';
import { hashKey } from '../src/middleware/auth';
import { getDb } from '../src/db';
import { ApiError, type HonoEnv } from '../src/types';
import type { MarketProduct } from '../src/lib/marketplace/types';
import { createMerchantDb } from './helpers/merchant-db';

const API = 'https://sellingpartnerapi-na.amazon.com';
const US = 'ATVPDKIKX0DER';
const NOW = new Date('2026-11-22T12:00:00Z');

afterEach(() => vi.unstubAllGlobals());

// ─── Fake SP-API ─────────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeAmazon(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${url.pathname}`];
    if (!handler) return Response.json({ errors: [{ code: 'NotFound', message: `unexpected ${call.method} ${url.pathname}` }] }, { status: 500 });
    return handler(call);
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}

function client(fetchMock: typeof fetch, opts: Partial<ConstructorParameters<typeof AmazonClient>[0]> = {}) {
  return new AmazonClient({
    tokens: { getAccessToken: async () => 'Atza|lwa', refresh: async () => 'Atza|lwa2' },
    sellerId: 'A2SELLER',
    marketplaceId: US,
    region: 'NA',
    channelId: 'ch-amz',
    fetch: fetchMock,
    sleep: async () => {},
    now: () => NOW,
    ...opts,
  });
}

const money = (Amount: string) => ({ CurrencyCode: 'USD', Amount });

const ORDER: AmazonOrderWire = {
  AmazonOrderId: '113-1234567-7654321',
  PurchaseDate: '2026-11-21T09:30:00Z',
  OrderStatus: 'Unshipped',
  FulfillmentChannel: 'MFN',
  MarketplaceId: US,
  OrderTotal: money('47.97'),
  BuyerInfo: { BuyerEmail: 'Ann@Example.com' },
  ShippingAddress: {
    Name: 'Ann Buyer',
    AddressLine1: '1 Main St',
    AddressLine2: 'Apt 2',
    City: 'Springfield',
    StateOrRegion: 'IL',
    PostalCode: '62701',
    CountryCode: 'US',
    Phone: '555-0100',
  },
};

const ITEMS: AmazonOrderItemWire[] = [
  {
    OrderItemId: 'OI-1',
    SellerSKU: 'TEE-RED-M',
    Title: 'Red tee',
    QuantityOrdered: 2,
    ItemPrice: money('39.98'),
    ItemTax: money('3.20'),
    ShippingPrice: money('4.99'),
    ShippingTax: money('0.40'),
    PromotionDiscount: money('0.60'),
  },
];

// ─── Mapping ─────────────────────────────────────────────────────────────────

describe('mapAmazonOrder', () => {
  it('maps a paid, unshipped order with buyer PII and per-line ids', () => {
    expect(mapAmazonOrder(ORDER, ITEMS, 'ch-amz')).toEqual({
      externalOrderId: '113-1234567-7654321',
      platform: 'amazon',
      channelStoreId: 'ch-amz',
      customerEmail: 'ann@example.com',
      items: [{ sku: 'TEE-RED-M', title: 'Red tee', qty: 2, unitPriceCents: 1999, externalLineItemId: 'OI-1' }],
      subtotalCents: 3938,
      taxCents: 360,
      shippingCents: 499,
      totalCents: 4797,
      currency: 'USD',
      status: 'NOT_STARTED',
      paymentStatus: 'PAID',
      cancelled: false,
      shippingAddress: {
        name: 'Ann Buyer',
        line1: '1 Main St',
        line2: 'Apt 2',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
        phone: '555-0100',
      },
      createdAt: '2026-11-21T09:30:00.000Z',
    });
  });

  it('marks Pending as unpaid, Canceled as cancelled, Shipped as fulfilled', () => {
    expect(mapAmazonOrder({ ...ORDER, OrderStatus: 'Pending' }, ITEMS).paymentStatus).toBe('PENDING');
    expect(mapAmazonOrder({ ...ORDER, OrderStatus: 'Canceled' }, ITEMS).cancelled).toBe(true);
    expect(mapAmazonOrder({ ...ORDER, OrderStatus: 'Shipped' }, ITEMS).status).toBe('FULFILLED');
  });

  it('uses a placeholder email for masked Amazon relay addresses or missing PII', () => {
    const masked = mapAmazonOrder({ ...ORDER, BuyerInfo: { BuyerEmail: 'x9k2@marketplace.amazon.com' } }, ITEMS);
    expect(masked.customerEmail).toBe('buyer-113-1234567-7654321@placeholder.local');
    const noPii = mapAmazonOrder({ ...ORDER, BuyerInfo: undefined, ShippingAddress: { City: 'Springfield', PostalCode: '62701', CountryCode: 'US' } }, ITEMS);
    expect(noPii.customerEmail).toMatch(/@placeholder\.local$/);
    expect(noPii.shippingAddress).toMatchObject({ line1: '', city: 'Springfield', country: 'US' });
  });

  it('drops lines with nothing ordered', () => {
    expect(mapAmazonOrder(ORDER, [...ITEMS, { OrderItemId: 'OI-2', SellerSKU: 'X', QuantityOrdered: 0 }]).items).toHaveLength(1);
  });
});

describe('listing and helper mapping', () => {
  it('maps a Listings Items record', () => {
    expect(
      mapAmazonListing(
        {
          sku: 'TEE-RED-M',
          summaries: [{ marketplaceId: US, asin: 'B0TEE', productType: 'SHIRT', status: ['BUYABLE', 'DISCOVERABLE'], itemName: 'Red tee', mainImage: { link: 'https://m.media/x.jpg' } }],
          offers: [{ marketplaceId: US, offerType: 'B2C', price: { currencyCode: 'USD', amount: '19.99' } }],
          fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 7 }],
        },
        US,
      ),
    ).toMatchObject({ id: 'B0TEE', sku: 'TEE-RED-M', title: 'Red tee', priceCents: 1999, currency: 'USD', quantity: 7, status: 'active', imageUrl: 'https://m.media/x.jpg' });
  });

  it('classifies barcodes, carriers and marketplaces', () => {
    expect(barcodeType('012345678905')).toBe('UPC');
    expect(barcodeType('4006381333931')).toBe('EAN');
    expect(barcodeType('00012345678905')).toBe('GTIN');
    expect(barcodeType('ABC')).toBeNull();
    expect(amazonCarrier('fedex')).toEqual({ carrierCode: 'FedEx' });
    expect(amazonCarrier('Pathao Courier')).toEqual({ carrierCode: 'Other', carrierName: 'Pathao Courier' });
    const parts = [
      { marketplace: { id: 'A2EUQ1WTGCTBG2' }, participation: { isParticipating: true } },
      { marketplace: { id: 'A1F83G8C2ARO7P' }, participation: { isParticipating: true } },
    ];
    expect(pickMarketplace(parts, US, 'NA')).toBe('A2EUQ1WTGCTBG2');
    expect(pickMarketplace(parts, 'A1F83G8C2ARO7P', 'NA')).toBe('A1F83G8C2ARO7P');
  });
});

// ─── App config + LWA ────────────────────────────────────────────────────────

describe('Amazon app config and LWA tokens', () => {
  const ENV = { AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.x', AMAZON_LWA_CLIENT_SECRET: 's', AMAZON_SP_APP_ID: 'amzn1.sp.solution.y', API_BASE_URL: 'https://api.shop.test/' };

  it('reads the app from env (old variable names too) and needs the SP app id', () => {
    expect(amazonAppFromEnv(ENV)).toMatchObject({
      redirectUri: 'https://api.shop.test/v1/marketplace/connect/amazon/callback',
      region: 'NA',
      marketplaceId: US,
      sellerCentralUrl: 'https://sellercentral.amazon.com',
      environment: 'production',
    });
    expect(amazonAppFromEnv({ ...ENV, AMAZON_LWA_CLIENT_ID: undefined, AMAZON_LWA_APP_ID: 'old' })?.clientId).toBe('old');
    expect(amazonAppFromEnv({ ...ENV, AMAZON_SP_APP_ID: undefined })).toBeNull();
    expect(amazonAppFromEnv({ ...ENV, AMAZON_REGION: 'eu' })).toMatchObject({ region: 'EU', marketplaceId: 'A1F83G8C2ARO7P', sellerCentralUrl: 'https://sellercentral-europe.amazon.com' });
  });

  it('builds the Seller Central consent URL (version=beta for draft apps)', () => {
    const app = amazonAppFromEnv(ENV)!;
    const url = new URL(buildAmazonAuthorizeUrl(app, 'st4te'));
    expect(url.origin + url.pathname).toBe('https://sellercentral.amazon.com/apps/authorize/consent');
    expect(Object.fromEntries(url.searchParams)).toEqual({ application_id: 'amzn1.sp.solution.y', state: 'st4te', redirect_uri: app.redirectUri });
    expect(new URL(buildAmazonAuthorizeUrl({ ...app, draft: true }, 's')).searchParams.get('version')).toBe('beta');
  });

  it('accepts only Seller Central hosts as amazon_callback_uri', () => {
    expect(isAmazonCallbackUri('https://sellercentral.amazon.com/apps/authorize/confirm/x')).toBe(true);
    expect(isAmazonCallbackUri('https://sellercentral-europe.amazon.com/apps/authorize/confirm/x')).toBe(true);
    expect(isAmazonCallbackUri('https://sellercentral.amazon.co.jp/x')).toBe(true);
    expect(isAmazonCallbackUri('https://evil.example/x')).toBe(false);
    expect(isAmazonCallbackUri('http://sellercentral.amazon.com/x')).toBe(false);
    expect(isAmazonCallbackUri('https://sellercentral.amazon.com.evil.example/x')).toBe(false);
  });

  it('exchanges the code at LWA with the client secret', async () => {
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'Atza|a', refresh_token: 'Atzr|r', expires_in: 3600 }));
    const tokens = await exchangeAmazonCode(amazonAppFromEnv(ENV)!, 'the-code', { fetch: fetchMock as unknown as typeof fetch, now: NOW });
    expect(tokens).toEqual({ accessToken: 'Atza|a', refreshToken: 'Atzr|r', accessTokenExpiresAt: '2026-11-22T13:00:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.amazon.com/auth/o2/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_secret: 's' });
  });

  it('refreshes an access token that is about to expire, keeping the refresh token', async () => {
    const { merchant } = createMerchantDb();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('c1', 'amazon', 'default')`);
    const creds = new CredentialManager(getDb(merchant as never), 'amazon-test-key-0123456789abcdef0123');
    await creds.saveCredential({ channelId: 'c1', type: 'oauth_token', value: 'old', expiresAt: new Date(NOW.getTime() + 60_000).toISOString() });
    await creds.saveCredential({ channelId: 'c1', type: 'refresh_token', value: 'Atzr|r' });
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'Atza|new', expires_in: 3600 }));
    const tm = new AmazonTokenManager({ channelId: 'c1', credentials: creds, app: { clientId: 'c', clientSecret: 's' }, fetch: fetchMock as unknown as typeof fetch, now: () => NOW });
    expect(await tm.getAccessToken()).toBe('Atza|new');
    expect(await creds.getSecret('c1', 'refresh_token')).toBe('Atzr|r');
  });
});

// ─── Client ──────────────────────────────────────────────────────────────────

describe('AmazonClient orders', () => {
  const ordersRoutes = (orders: AmazonOrderWire[]) => ({
    'POST /tokens/2021-03-01/restrictedDataToken': () => Response.json({ restrictedDataToken: 'Atz.sprdt|rdt', expiresIn: 3600 }),
    'GET /orders/v0/orders': () => Response.json({ payload: { Orders: orders } }),
    'GET /orders/v0/orders/113-1234567-7654321/orderItems': () => Response.json({ payload: { OrderItems: ITEMS } }),
  });

  it('lists MFN orders updated in the window, using an RDT for buyer PII', async () => {
    const { fetchMock, calls } = fakeAmazon(ordersRoutes([ORDER]));
    const orders = await client(fetchMock).listOrders({ from: new Date('2026-11-21T00:00:00Z'), to: NOW });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ customerEmail: 'ann@example.com', items: [{ externalLineItemId: 'OI-1' }] });

    const rdt = calls.find((c) => c.url.pathname.endsWith('restrictedDataToken'))!;
    expect(rdt.body).toEqual({ restrictedResources: [{ method: 'GET', path: '/orders/v0/orders', dataElements: ['buyerInfo', 'shippingAddress'] }] });
    expect(rdt.headers['x-amz-access-token']).toBe('Atza|lwa');

    const list = calls.find((c) => c.url.pathname === '/orders/v0/orders')!;
    expect(list.url.origin).toBe(API);
    expect(list.headers['x-amz-access-token']).toBe('Atz.sprdt|rdt');
    expect(list.headers).not.toHaveProperty('Authorization');
    expect(Object.fromEntries(list.url.searchParams)).toEqual({
      MarketplaceIds: US,
      LastUpdatedAfter: '2026-11-21T00:00:00.000Z',
      // `to` = now is later than Amazon allows (now - 2 min), so it is dropped.
      FulfillmentChannels: 'MFN',
      MaxResultsPerPage: '100',
    });

    const items = calls.find((c) => c.url.pathname.endsWith('/orderItems'))!;
    expect(items.headers['x-amz-access-token']).toBe('Atza|lwa');
  });

  it('follows NextToken pages', async () => {
    const second = { ...ORDER, AmazonOrderId: '113-0000000-0000002' };
    let page = 0;
    const { fetchMock, calls } = fakeAmazon({
      ...ordersRoutes([]),
      'GET /orders/v0/orders': () => Response.json({ payload: page++ === 0 ? { Orders: [ORDER], NextToken: 'nt1' } : { Orders: [second] } }),
      'GET /orders/v0/orders/113-0000000-0000002/orderItems': () => Response.json({ payload: { OrderItems: ITEMS } }),
    });
    const orders = await client(fetchMock).listOrders({ from: new Date('2026-11-21T00:00:00Z') });
    expect(orders.map((o) => o.externalOrderId)).toEqual(['113-1234567-7654321', '113-0000000-0000002']);
    const pages = calls.filter((c) => c.url.pathname === '/orders/v0/orders');
    expect(Object.fromEntries(pages[1].url.searchParams)).toEqual({ MarketplaceIds: US, NextToken: 'nt1' });
  });

  it('still imports, without PII, when the app has no restricted role', async () => {
    const { fetchMock, calls } = fakeAmazon({
      ...ordersRoutes([{ ...ORDER, BuyerInfo: undefined, ShippingAddress: undefined }]),
      'POST /tokens/2021-03-01/restrictedDataToken': () => Response.json({ errors: [{ code: 'Unauthorized', message: 'Access denied' }] }, { status: 403 }),
    });
    const c = client(fetchMock, { tokens: { getAccessToken: async () => 'Atza|lwa', refresh: async () => 'Atza|lwa' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [order] = await c.listOrders({ from: new Date('2026-11-21T00:00:00Z') });
    expect(order.customerEmail).toMatch(/@placeholder\.local$/);
    expect(calls.find((x) => x.url.pathname === '/orders/v0/orders')!.headers['x-amz-access-token']).toBe('Atza|lwa');
  });

  it('includes FBA orders only when asked', async () => {
    const { fetchMock, calls } = fakeAmazon(ordersRoutes([]));
    await client(fetchMock, { importFbaOrders: true, restrictedData: false }).listOrders({ from: NOW });
    expect(calls[0].url.searchParams.has('FulfillmentChannels')).toBe(false);
  });

  it('refreshes an expired LWA token once (403) and retries', async () => {
    let n = 0;
    const { fetchMock, calls } = fakeAmazon({
      'GET /orders/v0/orders/113-1234567-7654321': (c) =>
        c.headers['x-amz-access-token'] === 'Atza|lwa2'
          ? Response.json({ payload: { ...ORDER } })
          : Response.json({ errors: [{ code: 'Unauthorized', message: 'The access token you provided has expired.' }] }, { status: 403 }),
      'GET /orders/v0/orders/113-1234567-7654321/orderItems': () => Response.json({ payload: { OrderItems: ITEMS } }),
    });
    const refresh = vi.fn(async () => {
      n++;
      return 'Atza|lwa2';
    });
    const order = await client(fetchMock, { restrictedData: false, tokens: { getAccessToken: async () => 'Atza|lwa', refresh } }).getOrder('113-1234567-7654321');
    expect(order.externalOrderId).toBe('113-1234567-7654321');
    expect(n).toBe(1);
    expect(calls.filter((c) => c.url.pathname === '/orders/v0/orders/113-1234567-7654321')).toHaveLength(2);
  });

  it('backs off on 429 and, if still throttled, throws a retryable error', async () => {
    const sleep = vi.fn(async () => {});
    let n = 0;
    const { fetchMock } = fakeAmazon({
      'GET /orders/v0/orders': () => (n++ < 2 ? new Response('{}', { status: 429 }) : Response.json({ payload: { Orders: [] } })),
    });
    expect(await client(fetchMock, { sleep, restrictedData: false }).listOrders({ from: NOW })).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(2);

    const { fetchMock: always } = fakeAmazon({ 'GET /orders/v0/orders': () => new Response('{}', { status: 429 }) });
    const err = await client(always, { restrictedData: false }).listOrders({ from: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmazonApiError);
    expect(isRetryable(err)).toBe(true);
  });

  it('confirms a shipment with tracking for each order item', async () => {
    const { fetchMock, calls } = fakeAmazon({
      'POST /orders/v0/orders/113-1234567-7654321/shipmentConfirmation': () => new Response(null, { status: 204 }),
    });
    await client(fetchMock).createShippingFulfillment({
      orderId: '113-1234567-7654321',
      trackingNumber: '1Z999',
      shippingCarrierCode: 'ups',
      lineItems: [{ lineItemId: 'OI-1', quantity: 2 }],
    });
    expect(calls[0].body).toEqual({
      marketplaceId: US,
      packageDetail: {
        packageReferenceId: '1',
        carrierCode: 'UPS',
        trackingNumber: '1Z999',
        shipDate: NOW.toISOString(),
        orderItems: [{ orderItemId: 'OI-1', quantity: 2 }],
      },
    });
  });
});

describe('AmazonClient listings', () => {
  const product = (over: Partial<MarketProduct> = {}): MarketProduct => ({
    id: 'v1',
    sku: 'TEE-RED-M',
    title: 'Red tee',
    description: 'Soft cotton',
    priceCents: 1999,
    currency: 'USD',
    imageUrl: 'https://cdn.shop.test/tee.jpg',
    quantity: 5,
    weightG: 200,
    requiresShipping: true,
    status: 'active',
    ...over,
  });
  const listingPath = '/listings/2021-08-01/items/A2SELLER/TEE-RED-M';
  const notFound = () => Response.json({ errors: [{ code: 'NOT_FOUND', message: 'not found' }] }, { status: 404 });
  const accepted = () => Response.json({ sku: 'TEE-RED-M', status: 'ACCEPTED', submissionId: 's1', issues: [] });

  it('updates price and quantity on an existing listing with JSON patches', async () => {
    const { fetchMock, calls } = fakeAmazon({
      [`GET ${listingPath}`]: () => Response.json({ sku: 'TEE-RED-M', summaries: [{ marketplaceId: US, asin: 'B0TEE', productType: 'SHIRT' }] }),
      [`PATCH ${listingPath}`]: accepted,
    });
    expect(await client(fetchMock).upsertProduct(product())).toBe('TEE-RED-M');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.searchParams.get('marketplaceIds')).toBe(US);
    expect(patch.body).toEqual({
      productType: 'SHIRT',
      patches: [
        { op: 'replace', path: '/attributes/purchasable_offer', value: [{ marketplace_id: US, currency: 'USD', our_price: [{ schedule: [{ value_with_tax: 19.99 }] }] }] },
        { op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 5 }] },
      ],
    });
  });

  it('offers a new SKU on the catalog product matching its barcode', async () => {
    const { fetchMock, calls } = fakeAmazon({
      [`GET ${listingPath}`]: notFound,
      'GET /catalog/2022-04-01/items': () => Response.json({ items: [{ asin: 'B0FOUND', productTypes: [{ marketplaceId: US, productType: 'SHIRT' }] }] }),
      [`PUT ${listingPath}`]: accepted,
    });
    await client(fetchMock).upsertProduct(product({ barcode: '012345678905' }));
    const search = calls.find((c) => c.url.pathname.startsWith('/catalog'))!;
    expect(Object.fromEntries(search.url.searchParams)).toMatchObject({ identifiers: '012345678905', identifiersType: 'UPC', marketplaceIds: US });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      productType: 'SHIRT',
      requirements: 'LISTING_OFFER_ONLY',
      attributes: { merchant_suggested_asin: [{ value: 'B0FOUND', marketplace_id: US }], condition_type: [{ value: 'new_new', marketplace_id: US }] },
    });
  });

  it('creates a brand-new product only when the channel has a product type', async () => {
    const routes = { [`GET ${listingPath}`]: notFound, [`PUT ${listingPath}`]: accepted };
    const { fetchMock } = fakeAmazon(routes);
    const err = await client(fetchMock).upsertProduct(product()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: 'PRODUCT_TYPE_REQUIRED' });
    expect(isRetryable(err)).toBe(false);

    const { fetchMock: f2, calls } = fakeAmazon(routes);
    await client(f2, { listing: { productType: 'SHIRT', brand: 'Bengal' } }).upsertProduct(product());
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      productType: 'SHIRT',
      requirements: 'LISTING',
      attributes: {
        item_name: [{ value: 'Red tee', language_tag: 'en_US', marketplace_id: US }],
        brand: [{ value: 'Bengal', language_tag: 'en_US', marketplace_id: US }],
        supplier_declared_has_product_identifier_exemption: [{ value: true, marketplace_id: US }],
        main_product_image_locator: [{ media_location: 'https://cdn.shop.test/tee.jpg', marketplace_id: US }],
      },
    });
  });

  it('turns a rejected submission into a non-retryable error with Amazon’s reasons', async () => {
    const { fetchMock } = fakeAmazon({
      [`GET ${listingPath}`]: notFound,
      [`PUT ${listingPath}`]: () =>
        Response.json({ status: 'INVALID', issues: [{ code: '90220', message: "'color' is required but not supplied.", severity: 'ERROR', attributeNames: ['color'] }] }),
    });
    const err = await client(fetchMock, { listing: { productType: 'SHIRT' } }).upsertProduct(product()).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/'color' is required.*\[color\]/);
    expect(isRetryable(err)).toBe(false);
  });

  it('refuses a price in a currency the marketplace does not sell in', async () => {
    const { fetchMock, calls } = fakeAmazon({});
    await expect(client(fetchMock).upsertProduct(product({ currency: 'BDT' }))).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    expect(calls).toHaveLength(0);
  });

  it('pushes stock with a fulfillment_availability patch', async () => {
    const { fetchMock, calls } = fakeAmazon({
      [`GET ${listingPath}`]: () => Response.json({ sku: 'TEE-RED-M', summaries: [{ marketplaceId: US, productType: 'SHIRT' }] }),
      [`PATCH ${listingPath}`]: accepted,
    });
    await client(fetchMock).updateInventory('TEE-RED-M', 12);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      productType: 'SHIRT',
      patches: [{ op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 12 }] }],
    });
  });
});

// ─── Order import end to end ─────────────────────────────────────────────────

describe('Amazon orders → internal orders', () => {
  it('imports paid orders once, skips pending ones', async () => {
    const { merchant } = createMerchantDb();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id) VALUES ('ch-amz', 'amazon', 'default')`);
    const db = getDb(merchant as never);
    const pending = { ...ORDER, AmazonOrderId: '113-0000000-0000009', OrderStatus: 'Pending' };
    const { fetchMock } = fakeAmazon({
      'GET /orders/v0/orders': () => Response.json({ payload: { Orders: [ORDER, pending] } }),
      'GET /orders/v0/orders/113-1234567-7654321/orderItems': () => Response.json({ payload: { OrderItems: ITEMS } }),
      'GET /orders/v0/orders/113-0000000-0000009/orderItems': () => Response.json({ payload: { OrderItems: ITEMS } }),
    });
    const amazon = client(fetchMock, { restrictedData: false });

    const first = await importOrders(db, amazon, 'ch-amz');
    expect(first.imported.map((o) => o.number)).toEqual(['AMAZON-113-1234567-7654321']);
    expect(first.skipped).toEqual([{ externalOrderId: '113-0000000-0000009', reason: 'unpaid' }]);
    expect(merchant.query<any>(`SELECT status, total_cents, customer_email FROM orders`)).toEqual([
      { status: 'paid', total_cents: 4797, customer_email: 'ann@example.com' },
    ]);
    expect(merchant.query<any>(`SELECT external_line_item_id, qty FROM marketplace_order_lines`)).toEqual([{ external_line_item_id: 'OI-1', qty: 2 }]);

    const second = await importOrders(db, amazon, 'ch-amz');
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toContainEqual({ externalOrderId: '113-1234567-7654321', reason: 'already_imported' });
  });
});

// ─── Channel factory + routes ────────────────────────────────────────────────

const ADMIN_KEY = 'sk_test_admin_key';
const CRYPTOKEN = 'amazon-route-test-key-0123456789abcdef';
const ROUTE_ENV = {
  AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.x',
  AMAZON_LWA_CLIENT_SECRET: 'lwa-secret',
  AMAZON_SP_APP_ID: 'amzn1.sp.solution.y',
  API_BASE_URL: 'https://api.shop.test',
  STORE_URL: 'https://shop.test',
  CRYPTOKEN,
};

async function routeSetup() {
  const { merchant } = createMerchantDb();
  merchant.run(`INSERT INTO api_keys (id, key_hash, key_prefix, role) VALUES ('k1', ?, 'sk_', 'admin')`, [await hashKey(ADMIN_KEY)]);
  const app = new Hono<HonoEnv>();
  app.onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as 400));
  app.use('*', async (c, next) => {
    c.set('db', merchant as never);
    await next();
  });
  app.route('/v1/marketplace', marketplaceRoutes());
  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `/v1/marketplace${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      ROUTE_ENV,
    );
  return { merchant, call };
}

describe('Amazon connect routes', () => {
  it('returns the consent URL and stores the state', async () => {
    const { merchant, call } = await routeSetup();
    const res = await call('POST', '/connect/amazon');
    expect(res.status).toBe(200);
    const { authUrl, state } = (await res.json()) as { authUrl: string; state: string };
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://sellercentral.amazon.com/apps/authorize/consent');
    expect(url.searchParams.get('application_id')).toBe('amzn1.sp.solution.y');
    expect(url.searchParams.get('state')).toBe(state);
    expect(merchant.query(`SELECT platform FROM marketplace_oauth_states`)).toEqual([{ platform: 'amazon' }]);
  });

  it('the Login URI step sends the browser back to Seller Central with our state', async () => {
    const { call } = await routeSetup();
    const { state } = (await (await call('POST', '/connect/amazon')).json()) as { state: string };
    const cb = 'https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sp.solution.y';
    const res = await call('GET', `/connect/amazon/login?amazon_callback_uri=${encodeURIComponent(cb)}&amazon_state=AS1&selling_partner_id=A2SELLER`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(cb);
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      amazon_state: 'AS1',
      state,
      redirect_uri: 'https://api.shop.test/v1/marketplace/connect/amazon/callback',
    });

    const evil = await call('GET', `/connect/amazon/login?amazon_callback_uri=${encodeURIComponent('https://evil.example/x')}&amazon_state=AS1`);
    expect(evil.status).toBe(400);
  });

  it('the callback exchanges spapi_oauth_code, picks the marketplace and creates the channel', async () => {
    const { merchant, call } = await routeSetup();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://api.amazon.com/auth/o2/token') return Response.json({ access_token: 'Atza|a', refresh_token: 'Atzr|r', expires_in: 3600 });
      if (url === `${API}/sellers/v1/marketplaceParticipations`) {
        return Response.json({ payload: [{ marketplace: { id: 'A2EUQ1WTGCTBG2', countryCode: 'CA' }, participation: { isParticipating: true } }] });
      }
      return new Response('unexpected', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { state } = (await (await call('POST', '/connect/amazon')).json()) as { state: string };
    const res = await call('GET', `/connect/amazon/callback?state=${state}&spapi_oauth_code=CODE&selling_partner_id=A2SELLER`);
    expect(res.status).toBe(200);
    const { channelId } = (await res.json()) as { channelId: string };

    const [row] = merchant.query<any>(`SELECT platform, status, external_shop_id, config_json FROM marketplace_channels WHERE id = ?`, [channelId]);
    expect(row).toMatchObject({ platform: 'amazon', status: 'active', external_shop_id: 'A2SELLER' });
    expect(JSON.parse(row.config_json)).toEqual({ marketplace_id: 'A2EUQ1WTGCTBG2', region: 'NA', environment: 'production' });

    const creds = new CredentialManager(getDb(merchant as never), CRYPTOKEN);
    expect(await creds.getSecret(channelId, 'refresh_token')).toBe('Atzr|r');
    expect(await creds.getSecret(channelId, 'oauth_token')).toBe('Atza|a');

    const channel = await loadChannel(getDb(merchant as never), channelId);
    const amazon = amazonClientForChannel(getDb(merchant as never), ROUTE_ENV, channel);
    expect(amazon.config).toMatchObject({ sellerId: 'A2SELLER', marketplaceId: 'A2EUQ1WTGCTBG2', region: 'NA' });
  });

  it('reports a failed code exchange without creating a channel', async () => {
    const { merchant, call } = await routeSetup();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    const { state } = (await (await call('POST', '/connect/amazon')).json()) as { state: string };
    const res = await call('GET', `/connect/amazon/callback?state=${state}&spapi_oauth_code=BAD&selling_partner_id=A2SELLER`);
    expect(res.status).toBe(502);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(merchant.query(`SELECT * FROM marketplace_channels`)).toHaveLength(0);
  });

  it('queues sync jobs for Amazon channels', async () => {
    const { merchant } = await routeSetup();
    merchant.run(`INSERT INTO marketplace_channels (id, platform, store_id, status, external_shop_id) VALUES ('amz', 'amazon', 'default', 'active', 'A2SELLER')`);
    const sent: unknown[] = [];
    const { enqueueSyncJob } = await import('../src/lib/marketplace/sync-jobs');
    await enqueueSyncJob(getDb(merchant as never), { send: async (m) => void sent.push(m) }, 'amz', 'pull_orders');
    expect(sent).toHaveLength(1);
  });
});
