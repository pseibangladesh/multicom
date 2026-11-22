/**
 * MIT License
 *
 * Copyright (c) 2025 ygwyg
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

/**
 * Amazon Selling Partner API client implementing IMarketplaceClient.
 *
 * Auth: every request carries an LWA access token in `x-amz-access-token`
 * (AWS SigV4 signing is no longer required by SP-API). Calls that return
 * buyer PII (email, shipping address) use a Restricted Data Token (RDT)
 * instead; if the app lacks the PII role, orders import without them.
 *
 * APIs used:
 *   Listings Items 2021-08-01  products, price and quantity (keyed by seller SKU)
 *   Catalog Items 2022-04-01   barcode → ASIN, so a SKU can be offered on an existing product
 *   Orders v0                  order import and shipment confirmation
 *   Tokens 2021-03-01          RDTs for PII
 *   Sellers v1                 health check and marketplace discovery on connect
 *
 * Amazon is merchant-fulfilled (MFN) here: stock is pushed to the DEFAULT
 * fulfillment channel and FBA orders are not imported unless asked for, since
 * Amazon ships those from its own stock.
 */

import type { IMarketplaceClient, MarketInventoryItem, MarketOrder, MarketProduct, ShipmentClient } from './types';
import type { AmazonTokenProvider, AmazonEnvironment, AmazonRegion } from './amazon-oauth';
import { amazonApiBase, amazonMarketplace } from './amazon-oauth';
import { resolveBuyerEmail } from './buyer';

export const AMAZON_DEFAULT_CARRIER_FALLBACK = 'Other';
const USER_AGENT = 'BengalExchange/1.0 (Language=TypeScript; Platform=Cloudflare Workers)';
const LISTINGS = '/listings/2021-08-01/items';
const LISTING_DATA = 'summaries,attributes,offers,fulfillmentAvailability';
const MAX_THROTTLE_RETRIES = 3;

export class AmazonApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AmazonApiError';
  }
}

export interface AmazonListingDefaults {
  /** Amazon product type for brand-new products, e.g. "SHIRT", "HOME", "PRODUCT". */
  productType?: string;
  /** Listing condition, default "new_new". */
  conditionType?: string;
  /** Brand name for brand-new products. */
  brand?: string;
  /** Listing language, default from the marketplace (en_US, de_DE, ...). */
  languageTag?: string;
}

export interface AmazonClientOptions {
  tokens: AmazonTokenProvider;
  /** Selling partner (merchant) ID, from the authorization callback. */
  sellerId: string;
  marketplaceId: string;
  region: AmazonRegion;
  environment?: AmazonEnvironment;
  channelId?: string;
  listing?: AmazonListingDefaults;
  defaultCarrier?: string;
  /** Also import Fulfilled-by-Amazon orders (they deduct local stock). Default false. */
  importFbaOrders?: boolean;
  /** Request buyer email/address with a Restricted Data Token. Default true. */
  restrictedData?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

// ─── Wire types (only the fields we read) ────────────────────────────────────

interface SpApiError {
  code?: string;
  message?: string;
  details?: string;
}

interface AmazonMoney {
  CurrencyCode?: string;
  Amount?: string;
}

export interface AmazonOrderWire {
  AmazonOrderId: string;
  PurchaseDate?: string;
  OrderStatus?: string;
  FulfillmentChannel?: 'AFN' | 'MFN' | string;
  OrderTotal?: AmazonMoney;
  MarketplaceId?: string;
  BuyerInfo?: { BuyerEmail?: string; BuyerName?: string };
  ShippingAddress?: {
    Name?: string;
    AddressLine1?: string;
    AddressLine2?: string;
    AddressLine3?: string;
    City?: string;
    StateOrRegion?: string;
    PostalCode?: string;
    CountryCode?: string;
    Phone?: string;
  };
}

export interface AmazonOrderItemWire {
  OrderItemId: string;
  ASIN?: string;
  SellerSKU?: string;
  Title?: string;
  QuantityOrdered?: number;
  ItemPrice?: AmazonMoney;
  ItemTax?: AmazonMoney;
  ShippingPrice?: AmazonMoney;
  ShippingTax?: AmazonMoney;
  ShippingDiscount?: AmazonMoney;
  PromotionDiscount?: AmazonMoney;
}

interface ListingMoney {
  currencyCode?: string;
  currency?: string;
  amount?: string | number;
}

export interface AmazonListingItemWire {
  sku: string;
  summaries?: Array<{
    marketplaceId?: string;
    asin?: string;
    productType?: string;
    status?: string[];
    itemName?: string;
    mainImage?: { link?: string };
  }>;
  attributes?: Record<string, Array<Record<string, unknown>> | undefined>;
  offers?: Array<{ marketplaceId?: string; offerType?: string; price?: ListingMoney }>;
  fulfillmentAvailability?: Array<{ fulfillmentChannelCode?: string; quantity?: number }>;
}

interface ListingSubmission {
  sku?: string;
  status?: 'ACCEPTED' | 'INVALID' | string;
  issues?: Array<{ code?: string; message?: string; severity?: 'ERROR' | 'WARNING' | 'INFO' | string; attributeNames?: string[] }>;
}

// ─── Money ───────────────────────────────────────────────────────────────────

export function amazonMoneyToCents(m: { Amount?: string | number; amount?: string | number } | undefined | null): number {
  const raw = m?.Amount ?? m?.amount;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw ?? '');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function centsToDecimal(cents: number): number {
  return Math.round(cents) / 100;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

const UNPAID_STATUSES = new Set(['Pending', 'PendingAvailability']);
const CANCELLED_STATUSES = new Set(['Canceled', 'Cancelled', 'Unfulfillable']);

export function mapAmazonOrder(order: AmazonOrderWire, items: AmazonOrderItemWire[], channelStoreId = ''): MarketOrder {
  const ext = order.AmazonOrderId;
  const lines = items
    .filter((i) => (i.QuantityOrdered ?? 0) > 0)
    .map((i) => {
      const qty = i.QuantityOrdered ?? 1;
      return {
        sku: i.SellerSKU ?? i.ASIN ?? '',
        title: i.Title ?? '',
        qty,
        unitPriceCents: Math.round(amazonMoneyToCents(i.ItemPrice) / qty),
        externalLineItemId: i.OrderItemId,
      };
    });

  const sum = (pick: (i: AmazonOrderItemWire) => AmazonMoney | undefined) =>
    items.reduce((s, i) => s + amazonMoneyToCents(pick(i)), 0);
  const subtotalCents = sum((i) => i.ItemPrice) - sum((i) => i.PromotionDiscount);
  const taxCents = sum((i) => i.ItemTax) + sum((i) => i.ShippingTax);
  const shippingCents = sum((i) => i.ShippingPrice) - sum((i) => i.ShippingDiscount);

  const a = order.ShippingAddress;
  const hasAddress = Boolean(a && (a.AddressLine1 || a.City || a.PostalCode));
  const line2 = [a?.AddressLine2, a?.AddressLine3].filter(Boolean).join(', ');
  const status = order.OrderStatus ?? '';
  const currency =
    order.OrderTotal?.CurrencyCode ?? items.find((i) => i.ItemPrice?.CurrencyCode)?.ItemPrice?.CurrencyCode ??
    amazonMarketplace(order.MarketplaceId)?.currency ?? 'USD';

  return {
    externalOrderId: ext,
    platform: 'amazon',
    channelStoreId,
    customerEmail: resolveBuyerEmail(order.BuyerInfo?.BuyerEmail, ext),
    items: lines,
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: order.OrderTotal?.Amount !== undefined ? amazonMoneyToCents(order.OrderTotal) : subtotalCents + taxCents + shippingCents,
    currency,
    status: status === 'Shipped' ? 'FULFILLED' : 'NOT_STARTED',
    paymentStatus: UNPAID_STATUSES.has(status) ? 'PENDING' : 'PAID',
    cancelled: CANCELLED_STATUSES.has(status),
    ...(hasAddress && a && {
      shippingAddress: {
        name: a.Name ?? order.BuyerInfo?.BuyerName ?? '',
        line1: a.AddressLine1 ?? '',
        ...(line2 && { line2 }),
        city: a.City ?? '',
        ...(a.StateOrRegion && { state: a.StateOrRegion }),
        postalCode: a.PostalCode ?? '',
        country: a.CountryCode ?? '',
        ...(a.Phone && { phone: a.Phone }),
      },
    }),
    createdAt: order.PurchaseDate && !Number.isNaN(Date.parse(order.PurchaseDate)) ? new Date(order.PurchaseDate).toISOString() : new Date().toISOString(),
  };
}

function firstValue(attrs: AmazonListingItemWire['attributes'], key: string): string | undefined {
  const v = attrs?.[key]?.[0]?.value;
  return typeof v === 'string' ? v : undefined;
}

export function mapAmazonListing(item: AmazonListingItemWire, marketplaceId: string): MarketProduct {
  const summary = item.summaries?.find((s) => s.marketplaceId === marketplaceId) ?? item.summaries?.[0];
  const offer = item.offers?.find((o) => o.marketplaceId === marketplaceId && (o.offerType ?? 'B2C') === 'B2C') ?? item.offers?.[0];
  const availability = item.fulfillmentAvailability?.find((f) => f.fulfillmentChannelCode === 'DEFAULT');
  const statuses = summary?.status ?? [];
  return {
    id: summary?.asin ?? item.sku,
    sku: item.sku,
    title: summary?.itemName ?? firstValue(item.attributes, 'item_name') ?? '',
    description: firstValue(item.attributes, 'product_description') ?? '',
    priceCents: amazonMoneyToCents(offer?.price),
    currency: offer?.price?.currencyCode ?? offer?.price?.currency ?? amazonMarketplace(marketplaceId)?.currency ?? 'USD',
    imageUrl: summary?.mainImage?.link ?? null,
    quantity: availability?.quantity ?? 0,
    weightG: 0,
    requiresShipping: true,
    status: statuses.includes('BUYABLE') ? 'active' : statuses.includes('DISCOVERABLE') ? 'inactive' : 'draft',
  };
}

/** Barcode → Amazon identifier type, by digit count. */
export function barcodeType(barcode: string | null | undefined): 'UPC' | 'EAN' | 'GTIN' | null {
  const b = (barcode ?? '').trim();
  if (!/^\d+$/.test(b)) return null;
  if (b.length === 12) return 'UPC';
  if (b.length === 8 || b.length === 13) return 'EAN';
  if (b.length === 14) return 'GTIN';
  return null;
}

const KNOWN_CARRIERS = [
  'USPS', 'UPS', 'FedEx', 'DHL', 'DHL eCommerce', 'OnTrac', 'Amazon Shipping', 'Royal Mail', 'Parcelforce', 'DPD', 'Evri',
  'Hermes', 'GLS', 'Canada Post', 'Australia Post', 'Japan Post', 'Yamato Transport', 'Sagawa Express', 'Blue Dart', 'Other',
];

/** Amazon's carrierCode list; anything else is sent as "Other" with the name. */
export function amazonCarrier(raw: string): { carrierCode: string; carrierName?: string } {
  const name = raw.trim();
  const hit = KNOWN_CARRIERS.find((c) => c.toLowerCase() === name.toLowerCase());
  if (hit) return { carrierCode: hit };
  return { carrierCode: 'Other', ...(name && { carrierName: name }) };
}

// ─── Discovery on connect ────────────────────────────────────────────────────

export interface MarketplaceParticipation {
  marketplace: { id: string; countryCode?: string; defaultCurrencyCode?: string; name?: string };
  participation?: { isParticipating?: boolean };
}

/** GET /sellers/v1/marketplaceParticipations: proves the token works and lists the seller's marketplaces. */
export async function fetchMarketplaceParticipations(opts: {
  accessToken: string;
  region: AmazonRegion;
  environment?: AmazonEnvironment;
  fetch?: typeof fetch;
}): Promise<MarketplaceParticipation[]> {
  const res = await (opts.fetch ?? fetch)(`${amazonApiBase(opts.region, opts.environment)}/sellers/v1/marketplaceParticipations`, {
    headers: { 'x-amz-access-token': opts.accessToken, Accept: 'application/json', 'User-Agent': USER_AGENT },
  });
  const data = (await res.json().catch(() => ({}))) as { payload?: MarketplaceParticipation[]; errors?: SpApiError[] };
  if (!res.ok) {
    throw new AmazonApiError(`Amazon GET /sellers/v1/marketplaceParticipations failed (${res.status}): ${data.errors?.[0]?.message ?? ''}`, res.status);
  }
  return data.payload ?? [];
}

/** The configured marketplace if the seller sells there, else their first one in this region. */
export function pickMarketplace(participations: MarketplaceParticipation[], preferred: string, region: AmazonRegion): string {
  const active = participations.filter((p) => p.participation?.isParticipating !== false).map((p) => p.marketplace.id);
  if (active.includes(preferred)) return preferred;
  return active.find((id) => amazonMarketplace(id)?.region === region) ?? active[0] ?? preferred;
}

// ─── Client ──────────────────────────────────────────────────────────────────

type Query = Record<string, string | number | undefined>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class AmazonClient implements IMarketplaceClient, ShipmentClient {
  readonly platform = 'amazon' as const;
  readonly config: Record<string, unknown>;

  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;
  private readonly rdtCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly productTypeBySku = new Map<string, string>();
  private piiUnavailable = false;

  constructor(private readonly opts: AmazonClientOptions) {
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.base = amazonApiBase(opts.region, opts.environment);
    this.config = { sellerId: opts.sellerId, marketplaceId: opts.marketplaceId, region: opts.region, environment: opts.environment ?? 'production' };
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private get marketplace() {
    return amazonMarketplace(this.opts.marketplaceId);
  }

  private get languageTag(): string {
    return this.opts.listing?.languageTag ?? this.marketplace?.languageTag ?? 'en_US';
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async request<T>(
    method: Method,
    path: string,
    init: { query?: Query; json?: unknown; token?: string; allowStatus?: number[] } = {},
  ): Promise<{ status: number; data: T | null }> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));

    const send = (token: string) =>
      this.fetchFn(url.toString(), {
        method,
        headers: {
          'x-amz-access-token': token,
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(init.json !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(init.json !== undefined && { body: JSON.stringify(init.json) }),
      });

    let refreshed = false;
    let token = init.token ?? (await this.opts.tokens.getAccessToken());
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await send(token);
      // An expired LWA token comes back as 403 (sometimes 401). Refresh once.
      if ((res.status === 401 || res.status === 403) && !init.token && !refreshed) {
        refreshed = true;
        token = await this.opts.tokens.refresh();
        continue;
      }
      // Throttled: back off briefly; after that the sync queue retries the job.
      if ((res.status === 429 || res.status === 503) && attempt < MAX_THROTTLE_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 1000 * 2 ** attempt);
        continue;
      }
      break;
    }

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok && !init.allowStatus?.includes(res.status)) {
      const err = (data as { errors?: SpApiError[] } | null)?.errors?.[0];
      const detail = [err?.message, err?.details].filter(Boolean).join(' ');
      throw new AmazonApiError(`Amazon ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status, err?.code);
    }
    return { status: res.status, data: res.ok ? (data as T) : null };
  }

  /**
   * Restricted Data Token for one PII resource. Null when the app has no
   * PII role (orders then import without email/address); cached until expiry.
   */
  private async restrictedToken(path: string, dataElements: string[]): Promise<string | null> {
    if (this.opts.restrictedData === false || this.piiUnavailable) return null;
    const key = `${path}|${dataElements.join(',')}`;
    const cached = this.rdtCache.get(key);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.token;
    try {
      const { data } = await this.request<{ restrictedDataToken?: string; expiresIn?: number }>('POST', '/tokens/2021-03-01/restrictedDataToken', {
        json: { restrictedResources: [{ method: 'GET', path, dataElements }] },
      });
      if (!data?.restrictedDataToken) return null;
      this.rdtCache.set(key, { token: data.restrictedDataToken, expiresAt: this.now().getTime() + ((data.expiresIn ?? 3600) - 60) * 1000 });
      return data.restrictedDataToken;
    } catch (err) {
      if (err instanceof AmazonApiError && (err.status === 400 || err.status === 403)) {
        console.warn('[amazon] No PII access (restricted role missing); importing orders without buyer email/address');
        this.piiUnavailable = true;
        return null;
      }
      throw err;
    }
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async refreshTokens(): Promise<void> {
    await this.opts.tokens.refresh();
  }

  getAccessToken(): Promise<string> {
    return this.opts.tokens.getAccessToken();
  }

  // ── Products ────────────────────────────────────────────────────────────

  private get listingsPath() {
    return `${LISTINGS}/${encodeURIComponent(this.opts.sellerId)}`;
  }

  async listProducts(params: { limit?: number; cursor?: string } = {}) {
    const { data } = await this.request<{ items?: AmazonListingItemWire[]; pagination?: { nextToken?: string } }>('GET', this.listingsPath, {
      query: {
        marketplaceIds: this.opts.marketplaceId,
        includedData: LISTING_DATA,
        pageSize: Math.min(Math.max(params.limit ?? 20, 1), 20),
        pageToken: params.cursor,
      },
    });
    const items = data?.items ?? [];
    for (const i of items) {
      const pt = i.summaries?.[0]?.productType;
      if (pt) this.productTypeBySku.set(i.sku, pt);
    }
    const nextCursor = data?.pagination?.nextToken;
    return { items: items.map((i) => mapAmazonListing(i, this.opts.marketplaceId)), ...(nextCursor && { nextCursor }) };
  }

  private async getListingItem(sku: string): Promise<AmazonListingItemWire | null> {
    const { status, data } = await this.request<AmazonListingItemWire>('GET', `${this.listingsPath}/${encodeURIComponent(sku)}`, {
      query: { marketplaceIds: this.opts.marketplaceId, includedData: LISTING_DATA },
      allowStatus: [404],
    });
    if (status === 404 || !data) return null;
    const pt = data.summaries?.[0]?.productType;
    if (pt) this.productTypeBySku.set(sku, pt);
    return data;
  }

  async getProduct(sku: string): Promise<MarketProduct> {
    const item = await this.getListingItem(sku);
    if (!item) throw new AmazonApiError(`Amazon: no listing has SKU ${sku}`, 404);
    return mapAmazonListing(item, this.opts.marketplaceId);
  }

  private offerAttributes(product: MarketProduct) {
    const mp = this.opts.marketplaceId;
    const quantity = product.status === 'active' ? Math.max(0, product.quantity) : 0;
    return {
      purchasable_offer: [
        { marketplace_id: mp, currency: product.currency.toUpperCase(), our_price: [{ schedule: [{ value_with_tax: centsToDecimal(product.priceCents) }] }] },
      ],
      fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity }],
    };
  }

  private checkSubmission(sku: string, data: ListingSubmission | null): void {
    const errors = (data?.issues ?? []).filter((i) => i.severity === 'ERROR');
    if (data?.status === 'INVALID' || errors.length > 0) {
      const text = errors.map((i) => `${i.message ?? i.code}${i.attributeNames?.length ? ` [${i.attributeNames.join(', ')}]` : ''}`).join('; ');
      // A rejected listing is a data problem, not an outage: not retryable.
      throw new AmazonApiError(`Amazon rejected SKU ${sku}: ${text || data?.status || 'invalid'}`, 400, 'LISTING_INVALID');
    }
  }

  /** Barcode → ASIN (and its product type) through the catalog. */
  private async findCatalogItem(barcode: string | null | undefined): Promise<{ asin: string; productType?: string } | null> {
    const type = barcodeType(barcode);
    if (!type) return null;
    const { data } = await this.request<{ items?: Array<{ asin: string; productTypes?: Array<{ marketplaceId?: string; productType?: string }> }> }>(
      'GET',
      '/catalog/2022-04-01/items',
      {
        query: {
          identifiers: barcode!.trim(),
          identifiersType: type,
          marketplaceIds: this.opts.marketplaceId,
          includedData: 'summaries,productTypes',
        },
      },
    );
    const item = data?.items?.[0];
    if (!item) return null;
    const pt = item.productTypes?.find((p) => p.marketplaceId === this.opts.marketplaceId) ?? item.productTypes?.[0];
    return { asin: item.asin, ...(pt?.productType && { productType: pt.productType }) };
  }

  /**
   * Existing listing → update price and quantity. New SKU → an offer on the
   * catalog product matching its barcode, or (with a product type set on the
   * channel) a new product. Returns the seller SKU, which is how Amazon keys listings.
   */
  async upsertProduct(product: MarketProduct): Promise<string> {
    const mpCurrency = this.marketplace?.currency;
    if (mpCurrency && product.currency.toUpperCase() !== mpCurrency) {
      throw new AmazonApiError(
        `Amazon: SKU ${product.sku} is priced in ${product.currency.toUpperCase()} but this marketplace sells in ${mpCurrency}`,
        400,
        'CURRENCY_MISMATCH',
      );
    }
    const path = `${this.listingsPath}/${encodeURIComponent(product.sku)}`;
    const query = { marketplaceIds: this.opts.marketplaceId };
    const offer = this.offerAttributes(product);

    const existing = await this.getListingItem(product.sku);
    if (existing) {
      const productType = this.productTypeBySku.get(product.sku) ?? this.opts.listing?.productType ?? 'PRODUCT';
      const { data } = await this.request<ListingSubmission>('PATCH', path, {
        query,
        json: {
          productType,
          patches: [
            { op: 'replace', path: '/attributes/purchasable_offer', value: offer.purchasable_offer },
            { op: 'replace', path: '/attributes/fulfillment_availability', value: offer.fulfillment_availability },
          ],
        },
      });
      this.checkSubmission(product.sku, data);
      return product.sku;
    }

    const mp = this.opts.marketplaceId;
    const condition = [{ value: this.opts.listing?.conditionType ?? 'new_new', marketplace_id: mp }];
    const catalog = await this.findCatalogItem(product.barcode);

    let body: Record<string, unknown>;
    if (catalog) {
      body = {
        productType: catalog.productType ?? this.opts.listing?.productType ?? 'PRODUCT',
        requirements: 'LISTING_OFFER_ONLY',
        attributes: { condition_type: condition, merchant_suggested_asin: [{ value: catalog.asin, marketplace_id: mp }], ...offer },
      };
    } else {
      const productType = this.opts.listing?.productType;
      if (!productType) {
        throw new AmazonApiError(
          `Amazon: SKU ${product.sku} is not on Amazon yet. Give it a barcode (UPC/EAN) that exists in Amazon's catalog, or set a product type on the channel to create a new product.`,
          400,
          'PRODUCT_TYPE_REQUIRED',
        );
      }
      const lang = this.languageTag;
      const idType = barcodeType(product.barcode);
      body = {
        productType,
        requirements: 'LISTING',
        attributes: {
          item_name: [{ value: product.title.slice(0, 200), language_tag: lang, marketplace_id: mp }],
          ...(this.opts.listing?.brand && { brand: [{ value: this.opts.listing.brand, language_tag: lang, marketplace_id: mp }] }),
          ...(product.description && {
            product_description: [{ value: product.description.slice(0, 2000), language_tag: lang, marketplace_id: mp }],
          }),
          ...(idType
            ? { externally_assigned_product_identifier: [{ type: idType.toLowerCase(), value: product.barcode!.trim(), marketplace_id: mp }] }
            : { supplier_declared_has_product_identifier_exemption: [{ value: true, marketplace_id: mp }] }),
          ...(product.imageUrl && { main_product_image_locator: [{ media_location: product.imageUrl, marketplace_id: mp }] }),
          condition_type: condition,
          ...offer,
        },
      };
    }

    const { data } = await this.request<ListingSubmission>('PUT', path, { query, json: body });
    this.checkSubmission(product.sku, data);
    this.productTypeBySku.set(product.sku, String(body.productType));
    return product.sku;
  }

  async deleteProduct(sku: string): Promise<void> {
    await this.request('DELETE', `${this.listingsPath}/${encodeURIComponent(sku)}`, {
      query: { marketplaceIds: this.opts.marketplaceId },
      allowStatus: [404],
    });
    this.productTypeBySku.delete(sku);
  }

  // ── Inventory ───────────────────────────────────────────────────────────

  async listInventory(params: { limit?: number } = {}): Promise<MarketInventoryItem[]> {
    const max = params.limit ?? Infinity;
    const out: MarketInventoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listProducts({ cursor });
      out.push(...page.items.map((p) => ({ sku: p.sku, quantity: p.quantity })));
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return max === Infinity ? out : out.slice(0, max);
  }

  async updateInventory(sku: string, quantity: number): Promise<void> {
    let productType = this.productTypeBySku.get(sku);
    if (!productType) {
      const item = await this.getListingItem(sku);
      if (!item) throw new AmazonApiError(`Amazon: no listing has SKU ${sku}`, 404);
      productType = this.productTypeBySku.get(sku) ?? this.opts.listing?.productType ?? 'PRODUCT';
    }
    const { data } = await this.request<ListingSubmission>('PATCH', `${this.listingsPath}/${encodeURIComponent(sku)}`, {
      query: { marketplaceIds: this.opts.marketplaceId },
      json: {
        productType,
        patches: [
          { op: 'replace', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: Math.max(0, quantity) }] },
        ],
      },
    });
    this.checkSubmission(sku, data);
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  private async getOrderItems(orderId: string): Promise<AmazonOrderItemWire[]> {
    const out: AmazonOrderItemWire[] = [];
    let nextToken: string | undefined;
    do {
      const { data } = await this.request<{ payload?: { OrderItems?: AmazonOrderItemWire[]; NextToken?: string } }>(
        'GET',
        `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
        { query: { NextToken: nextToken } },
      );
      out.push(...(data?.payload?.OrderItems ?? []));
      nextToken = data?.payload?.NextToken;
    } while (nextToken);
    return out;
  }

  /**
   * Orders updated (default) or created in the window. Updated is what the
   * import wants: a Pending order becomes importable once payment clears.
   */
  async listOrders(params: { from?: Date; to?: Date; limit?: number; by?: 'created' | 'modified' } = {}): Promise<MarketOrder[]> {
    const max = Math.min(params.limit ?? 500, 500);
    const from = params.from ?? new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
    // Amazon rejects an upper bound later than two minutes ago.
    const latest = new Date(this.now().getTime() - 2 * 60 * 1000);
    const to = params.to && params.to < latest ? params.to : undefined;
    const [afterKey, beforeKey] = params.by === 'created' ? ['CreatedAfter', 'CreatedBefore'] : ['LastUpdatedAfter', 'LastUpdatedBefore'];

    const rdt = await this.restrictedToken('/orders/v0/orders', ['buyerInfo', 'shippingAddress']);
    const out: MarketOrder[] = [];
    let nextToken: string | undefined;
    do {
      const query: Query = nextToken
        ? { MarketplaceIds: this.opts.marketplaceId, NextToken: nextToken }
        : {
            MarketplaceIds: this.opts.marketplaceId,
            [afterKey]: from.toISOString(),
            [beforeKey]: to?.toISOString(),
            FulfillmentChannels: this.opts.importFbaOrders ? undefined : 'MFN',
            MaxResultsPerPage: Math.min(100, max),
          };
      const { data } = await this.request<{ payload?: { Orders?: AmazonOrderWire[]; NextToken?: string } }>('GET', '/orders/v0/orders', {
        query,
        ...(rdt && { token: rdt }),
      });
      for (const order of data?.payload?.Orders ?? []) {
        if (out.length >= max) break;
        out.push(mapAmazonOrder(order, await this.getOrderItems(order.AmazonOrderId), this.opts.channelId));
      }
      nextToken = data?.payload?.NextToken;
    } while (nextToken && out.length < max);
    return out;
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    const path = `/orders/v0/orders/${encodeURIComponent(externalOrderId)}`;
    const rdt = await this.restrictedToken(path, ['buyerInfo', 'shippingAddress']);
    const { data } = await this.request<{ payload?: AmazonOrderWire }>('GET', path, rdt ? { token: rdt } : {});
    if (!data?.payload) throw new AmazonApiError(`Amazon: order ${externalOrderId} not found`, 404);
    return mapAmazonOrder(data.payload, await this.getOrderItems(externalOrderId), this.opts.channelId);
  }

  /** Confirm shipment with tracking (Orders v0 confirmShipment; not a PII call). */
  async createShippingFulfillment(input: {
    orderId: string;
    trackingNumber: string;
    shippingCarrierCode: string;
    lineItems?: Array<{ lineItemId: string; quantity: number }>;
  }): Promise<void> {
    const lines =
      input.lineItems && input.lineItems.length > 0
        ? input.lineItems
        : (await this.getOrderItems(input.orderId))
            .filter((i) => (i.QuantityOrdered ?? 0) > 0)
            .map((i) => ({ lineItemId: i.OrderItemId, quantity: i.QuantityOrdered ?? 1 }));

    await this.request('POST', `/orders/v0/orders/${encodeURIComponent(input.orderId)}/shipmentConfirmation`, {
      json: {
        marketplaceId: this.opts.marketplaceId,
        packageDetail: {
          packageReferenceId: '1',
          ...amazonCarrier(input.shippingCarrierCode),
          trackingNumber: input.trackingNumber,
          shipDate: this.now().toISOString(),
          orderItems: lines.map((l) => ({ orderItemId: l.lineItemId, quantity: l.quantity })),
        },
      },
    });
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    await this.createShippingFulfillment({
      orderId: externalOrderId,
      trackingNumber,
      shippingCarrierCode: this.opts.defaultCarrier ?? AMAZON_DEFAULT_CARRIER_FALLBACK,
    });
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', '/sellers/v1/marketplaceParticipations');
      return true;
    } catch {
      return false;
    }
  }
}
