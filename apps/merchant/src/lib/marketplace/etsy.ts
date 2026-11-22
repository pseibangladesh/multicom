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
 * Etsy Open API v3 client implementing IMarketplaceClient.
 *
 *   Listings   /v3/application/shops/{shop_id}/listings, /listings/{id}/inventory
 *   Receipts   /v3/application/shops/{shop_id}/receipts (orders) + /tracking
 *
 * Identity: one Etsy listing per variant, holding a single inventory product
 * whose SKU is ours. The external product ID is the listing_id. Listings made
 * by hand on Etsy may carry several products (variations); updates only touch
 * the product whose SKU matches and keep the others as they are.
 *
 * Etsy has no SKU lookup endpoint, so the client scans the shop's listings
 * (the `skus` field) once and caches SKU → listing_id for its lifetime.
 *
 * Creating a listing needs channel defaults (taxonomy, shipping profile,
 * readiness state). Etsy will not activate a listing without a photo, so a new
 * listing whose product has no imageUrl stays a draft.
 *
 * Tokens come from an EtsyTokenProvider (see etsy-oauth.ts). A 401 triggers one
 * forced refresh and a retry. `fetch` is injectable for tests.
 */

import type { IMarketplaceClient, MarketProduct, MarketInventoryItem, MarketOrder } from './types';
import type { EtsyTokenProvider } from './etsy-oauth';
import { resolveBuyerEmail } from './buyer';

export const ETSY_API_BASE = 'https://api.etsy.com/v3/application';

/** Etsy's catch-all carrier name; tracking still uploads without a carrier link. */
export const ETSY_DEFAULT_CARRIER_FALLBACK = 'other';

export interface EtsyListingDefaults {
  taxonomyId: number;
  shippingProfileId: number;
  /** Processing profile; Etsy requires it on new physical listings. */
  readinessStateId?: number;
  returnPolicyId?: number;
  whoMade?: 'i_did' | 'someone_else' | 'collective';
  /** e.g. made_to_order, 2020_2026. */
  whenMade?: string;
  isSupply?: boolean;
}

export interface EtsyClientOptions {
  tokens: EtsyTokenProvider;
  /** x-api-key value: "keystring:shared_secret". */
  apiKey: string;
  shopId: string;
  listing?: EtsyListingDefaults;
  /** carrier_name used by updateShipment (e.g. usps, ups, fedex, royal-mail). */
  defaultCarrier?: string;
  /** Used for channelStoreId on mapped orders. */
  channelId?: string;
  rateLimiter?: { acquire(platform: string): Promise<boolean> };
  fetch?: typeof fetch;
}

export class EtsyApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EtsyApiError';
  }
}

// ─── Etsy wire types (only the fields we read) ───────────────────────────────

export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

interface EtsyPropertyValue {
  property_id: number;
  property_name?: string | null;
  scale_id?: number | null;
  value_ids: number[];
  values: string[];
}

interface EtsyOffering {
  offering_id?: number;
  price: EtsyMoney;
  quantity: number;
  is_enabled: boolean;
  is_deleted?: boolean;
}

interface EtsyInventoryProduct {
  product_id?: number;
  sku: string;
  is_deleted?: boolean;
  offerings: EtsyOffering[];
  property_values: EtsyPropertyValue[];
}

export interface EtsyInventory {
  products: EtsyInventoryProduct[];
  price_on_property?: number[];
  quantity_on_property?: number[];
  sku_on_property?: number[];
}

export interface EtsyListing {
  listing_id: number;
  title?: string;
  description?: string;
  state?: string; // active | inactive | sold_out | draft | expired
  quantity?: number;
  price?: EtsyMoney;
  skus?: string[];
  item_weight?: number | null;
  item_weight_unit?: string | null;
  images?: Array<{ url_fullxfull?: string; url_570xN?: string }>;
  inventory?: EtsyInventory;
}

export interface EtsyReceipt {
  receipt_id: number;
  status?: string; // paid | completed | open | payment processing | canceled | fully refunded | partially refunded
  is_paid?: boolean;
  is_shipped?: boolean;
  buyer_email?: string | null;
  name?: string | null;
  first_line?: string | null;
  second_line?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country_iso?: string | null;
  created_timestamp?: number;
  create_timestamp?: number;
  subtotal?: EtsyMoney;
  total_price?: EtsyMoney;
  grandtotal?: EtsyMoney;
  total_shipping_cost?: EtsyMoney;
  total_tax_cost?: EtsyMoney;
  total_vat_cost?: EtsyMoney;
  transactions?: Array<{
    transaction_id: number;
    title?: string | null;
    quantity?: number;
    /** Unit price. */
    price?: EtsyMoney;
    sku?: string | null;
  }>;
}

// ─── Money ───────────────────────────────────────────────────────────────────

/** {amount: 1234, divisor: 100} → 1234. */
export function etsyMoneyToCents(m: EtsyMoney | undefined | null): number {
  if (!m || !m.divisor) return 0;
  return Math.round((m.amount * 100) / m.divisor);
}

/** Etsy write endpoints take prices as a decimal number in the shop currency. */
export function centsToEtsyPrice(cents: number): number {
  return Math.round(cents) / 100;
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

const PAYMENT_STATUS_BY_RECEIPT_STATUS: Record<string, string> = {
  'fully refunded': 'FULLY_REFUNDED',
  'partially refunded': 'PARTIALLY_REFUNDED',
};

/** Normalizes to the eBay-style values order-import understands (PAID, FULFILLED, …). */
export function mapEtsyReceipt(r: EtsyReceipt, channelStoreId = ''): MarketOrder {
  const ext = String(r.receipt_id);
  const status = (r.status ?? '').toLowerCase();

  const items = (r.transactions ?? []).map((t) => ({
    sku: t.sku ?? '',
    title: t.title ?? '',
    qty: t.quantity ?? 1,
    unitPriceCents: etsyMoneyToCents(t.price),
    externalLineItemId: String(t.transaction_id),
  }));

  const subtotalCents = r.subtotal
    ? etsyMoneyToCents(r.subtotal)
    : r.total_price
      ? etsyMoneyToCents(r.total_price)
      : items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
  const taxCents = etsyMoneyToCents(r.total_tax_cost) + etsyMoneyToCents(r.total_vat_cost);
  const shippingCents = etsyMoneyToCents(r.total_shipping_cost);

  const hasAddress = Boolean(r.first_line || r.city || r.zip);
  const createdSec = r.created_timestamp ?? r.create_timestamp;

  return {
    externalOrderId: ext,
    platform: 'etsy',
    channelStoreId,
    customerEmail: resolveBuyerEmail(r.buyer_email, ext),
    items,
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: r.grandtotal ? etsyMoneyToCents(r.grandtotal) : subtotalCents + taxCents + shippingCents,
    currency: r.grandtotal?.currency_code ?? r.subtotal?.currency_code ?? r.total_price?.currency_code ?? 'USD',
    status: r.is_shipped || status === 'completed' ? 'FULFILLED' : 'NOT_STARTED',
    paymentStatus: PAYMENT_STATUS_BY_RECEIPT_STATUS[status] ?? (r.is_paid ? 'PAID' : 'PENDING'),
    cancelled: status === 'canceled' || status === 'cancelled',
    ...(hasAddress && {
      shippingAddress: {
        name: r.name ?? '',
        line1: r.first_line ?? '',
        ...(r.second_line && { line2: r.second_line }),
        city: r.city ?? '',
        ...(r.state && { state: r.state }),
        postalCode: r.zip ?? '',
        country: r.country_iso ?? '',
      },
    }),
    createdAt: createdSec ? new Date(createdSec * 1000).toISOString() : new Date().toISOString(),
  };
}

const GRAMS_PER_UNIT: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

function listingStatus(state: string | undefined): MarketProduct['status'] {
  if (state === 'active') return 'active';
  if (state === 'draft') return 'draft';
  return 'inactive';
}

/** One MarketProduct per live inventory product (variant) of the listing. */
export function mapEtsyListing(l: EtsyListing): MarketProduct[] {
  const base = {
    id: String(l.listing_id),
    title: l.title ?? '',
    description: l.description ?? '',
    imageUrl: l.images?.[0]?.url_fullxfull ?? l.images?.[0]?.url_570xN ?? null,
    weightG: l.item_weight ? Math.round(l.item_weight * (GRAMS_PER_UNIT[l.item_weight_unit ?? 'g'] ?? 1)) : 0,
    requiresShipping: true,
    status: listingStatus(l.state),
  };

  const products = (l.inventory?.products ?? []).filter((p) => !p.is_deleted);
  if (products.length === 0) {
    return [
      {
        ...base,
        sku: l.skus?.[0] ?? '',
        priceCents: etsyMoneyToCents(l.price),
        currency: l.price?.currency_code ?? 'USD',
        quantity: l.quantity ?? 0,
      },
    ];
  }
  return products.map((p) => {
    const offer = p.offerings.find((o) => !o.is_deleted) ?? p.offerings[0];
    return {
      ...base,
      sku: p.sku,
      priceCents: etsyMoneyToCents(offer?.price ?? l.price),
      currency: offer?.price?.currency_code ?? l.price?.currency_code ?? 'USD',
      quantity: offer?.is_enabled === false ? 0 : (offer?.quantity ?? 0),
    };
  });
}

/**
 * GET inventory → PUT body. Drops read-only fields and converts prices; `patch`
 * changes the offerings of the product with the given SKU.
 */
export function inventoryWriteBody(
  inv: EtsyInventory,
  patch?: { sku: string; priceCents?: number; quantity?: number },
): Record<string, unknown> {
  return {
    products: inv.products
      .filter((p) => !p.is_deleted)
      .map((p) => {
        const hit = patch && p.sku === patch.sku;
        return {
          sku: p.sku,
          property_values: p.property_values.map((v) => ({
            property_id: v.property_id,
            ...(v.property_name != null && { property_name: v.property_name }),
            ...(v.scale_id != null && { scale_id: v.scale_id }),
            value_ids: v.value_ids,
            values: v.values,
          })),
          offerings: p.offerings
            .filter((o) => !o.is_deleted)
            .map((o) => ({
              price:
                hit && patch.priceCents !== undefined ? centsToEtsyPrice(patch.priceCents) : etsyMoneyToCents(o.price) / 100,
              quantity: hit && patch.quantity !== undefined ? Math.max(0, patch.quantity) : o.quantity,
              is_enabled: o.is_enabled,
            })),
        };
      }),
    price_on_property: inv.price_on_property ?? [],
    quantity_on_property: inv.quantity_on_property ?? [],
    sku_on_property: inv.sku_on_property ?? [],
  };
}

/** GET /users/me with a fresh token: identifies the seller's shop after OAuth. */
export async function fetchEtsyShopId(opts: { accessToken: string; apiKey: string; fetch?: typeof fetch }): Promise<string> {
  const res = await (opts.fetch ?? fetch)(`${ETSY_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${opts.accessToken}`, 'x-api-key': opts.apiKey, Accept: 'application/json' },
  });
  const data = (await res.json().catch(() => ({}))) as { shop_id?: number | null; error?: string };
  if (!res.ok) throw new EtsyApiError(`Etsy GET /users/me failed (${res.status})${data.error ? `: ${data.error}` : ''}`, res.status);
  if (!data.shop_id) throw new EtsyApiError('Etsy account has no shop', 400);
  return String(data.shop_id);
}

// ─── Client ──────────────────────────────────────────────────────────────────

type Query = Record<string, string | number | boolean | undefined>;
type Form = Record<string, string | number | boolean | undefined>;

/** Listing states scanned by listProducts, in order. */
const LISTING_STATES = ['active', 'draft', 'inactive', 'sold_out', 'expired'] as const;
const PAGE_MAX = 100;

export class EtsyClient implements IMarketplaceClient {
  readonly platform = 'etsy' as const;
  /** Non-secret settings (tokens never live here). */
  readonly config: Record<string, unknown>;

  private readonly fetchFn: typeof fetch;
  /** SKU → listing_id, filled by every listing page read. */
  private readonly skuIndex = new Map<string, string>();
  private skuIndexComplete = false;

  constructor(private readonly opts: EtsyClientOptions) {
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.config = { shopId: opts.shopId, listing: opts.listing ?? null };
  }

  private get shopPath() {
    return `/shops/${encodeURIComponent(this.opts.shopId)}`;
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { query?: Query; json?: unknown; form?: Form; multipart?: FormData; allowStatus?: number[] } = {},
  ): Promise<{ status: number; data: T | null }> {
    if (this.opts.rateLimiter && !(await this.opts.rateLimiter.acquire('etsy'))) {
      throw new EtsyApiError('Etsy: rate limit exceeded (local quota)', 429);
    }

    const url = new URL(ETSY_API_BASE + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      contentType = 'application/json';
    } else if (init.form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) if (v !== undefined) params.set(k, String(v));
      body = params.toString();
      contentType = 'application/x-www-form-urlencoded';
    } else if (init.multipart) {
      body = init.multipart; // fetch sets the multipart boundary
    }

    const send = (token: string) =>
      this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': this.opts.apiKey,
          Accept: 'application/json',
          ...(contentType && { 'Content-Type': contentType }),
        },
        body,
      });

    let res = await send(await this.opts.tokens.getAccessToken());
    if (res.status === 401) res = await send(await this.opts.tokens.refresh());

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok && !init.allowStatus?.includes(res.status)) {
      const detail = (data as { error?: string } | null)?.error ?? '';
      throw new EtsyApiError(`Etsy ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
    }
    return { status: res.status, data: res.ok ? (data as T) : null };
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async refreshTokens(): Promise<void> {
    await this.opts.tokens.refresh();
  }

  getAccessToken(): Promise<string> {
    return this.opts.tokens.getAccessToken();
  }

  // ── Products ────────────────────────────────────────────────────────────

  /**
   * Walks every listing state. cursor = "<stateIndex>:<offset>". A page may
   * hold more items than `limit` when listings have several variants.
   */
  async listProducts(params: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(params.limit ?? PAGE_MAX, 1), PAGE_MAX);
    const [si, off] = (params.cursor ?? '0:0').split(':').map((n) => Number(n) || 0);
    const state = LISTING_STATES[si];
    if (!state) return { items: [] };

    const { data } = await this.request<{ count?: number; results?: EtsyListing[] }>('GET', `${this.shopPath}/listings`, {
      query: { state, limit, offset: off, includes: 'Images,Inventory' },
    });
    const listings = data?.results ?? [];
    this.indexSkus(listings);

    const nextOffset = off + listings.length;
    const moreInState = listings.length > 0 && nextOffset < (data?.count ?? 0);
    const nextCursor = moreInState ? `${si}:${nextOffset}` : si + 1 < LISTING_STATES.length ? `${si + 1}:0` : undefined;
    return { items: listings.flatMap(mapEtsyListing), ...(nextCursor && { nextCursor }) };
  }

  /** `id` is the listing_id; returns its first variant. */
  async getProduct(id: string): Promise<MarketProduct> {
    const listing = await this.getListing(id);
    return mapEtsyListing(listing)[0];
  }

  /** Creates or updates the listing carrying this SKU. Returns the listing_id. */
  async upsertProduct(product: MarketProduct): Promise<string> {
    const existing = await this.findListingIdBySku(product.sku);
    return existing ? this.updateListing(existing, product) : this.createListing(product);
  }

  async deleteProduct(listingId: string): Promise<void> {
    await this.request('DELETE', `/listings/${encodeURIComponent(listingId)}`, { allowStatus: [404] });
    for (const [sku, id] of this.skuIndex) if (id === listingId) this.skuIndex.delete(sku);
  }

  private async getListing(listingId: string): Promise<EtsyListing> {
    const { data } = await this.request<EtsyListing>('GET', `/listings/${encodeURIComponent(listingId)}`, {
      query: { includes: 'Images,Inventory' },
    });
    return data!;
  }

  private async createListing(product: MarketProduct): Promise<string> {
    const d = this.opts.listing;
    if (!d) {
      throw new Error('Etsy: set listing defaults (taxonomy_id, shipping_profile_id) on the channel before creating listings');
    }

    const { data } = await this.request<EtsyListing>('POST', `${this.shopPath}/listings`, {
      form: {
        // Etsy rejects quantity 0 on create; the inventory PUT below sets the real figure.
        quantity: Math.max(1, product.quantity),
        title: product.title.slice(0, 140), // Etsy's title limit
        description: product.description || product.title,
        price: centsToEtsyPrice(product.priceCents),
        who_made: d.whoMade ?? 'i_did',
        when_made: d.whenMade ?? 'made_to_order',
        is_supply: d.isSupply ?? false,
        taxonomy_id: d.taxonomyId,
        shipping_profile_id: d.shippingProfileId,
        readiness_state_id: d.readinessStateId,
        return_policy_id: d.returnPolicyId,
        type: 'physical',
        ...(product.weightG > 0 && { item_weight: product.weightG, item_weight_unit: 'g' }),
      },
    });
    const listingId = String(data!.listing_id);
    this.skuIndex.set(product.sku, listingId);

    await this.request('PUT', `/listings/${listingId}/inventory`, {
      json: {
        products: [
          {
            sku: product.sku,
            property_values: [],
            offerings: [{ price: centsToEtsyPrice(product.priceCents), quantity: Math.max(0, product.quantity), is_enabled: true }],
          },
        ],
      },
    });

    if (product.imageUrl) {
      await this.uploadImage(listingId, product.imageUrl);
      if (product.status === 'active') {
        await this.request('PATCH', `${this.shopPath}/listings/${listingId}`, { form: { state: 'active' } });
      }
    }
    return listingId;
  }

  private async updateListing(listingId: string, product: MarketProduct): Promise<string> {
    const listing = await this.getListing(listingId);
    const products = (listing.inventory?.products ?? []).filter((p) => !p.is_deleted);

    // Title/description belong to the whole listing: only overwrite them when
    // this variant is the listing's only product.
    const ownsListing = products.length <= 1;
    const state =
      product.status === 'active' && (listing.state === 'draft' || listing.state === 'inactive')
        ? 'active'
        : product.status !== 'active' && listing.state === 'active'
          ? 'inactive'
          : undefined;

    const form: Form = {
      ...(ownsListing && { title: product.title.slice(0, 140), description: product.description || product.title }),
      ...(state && { state }),
    };
    if (Object.keys(form).length > 0) {
      await this.request('PATCH', `${this.shopPath}/listings/${listingId}`, { form });
    }

    if (listing.inventory) {
      await this.request('PUT', `/listings/${listingId}/inventory`, {
        json: inventoryWriteBody(listing.inventory, { sku: product.sku, priceCents: product.priceCents, quantity: product.quantity }),
      });
    }
    return listingId;
  }

  private async uploadImage(listingId: string, imageUrl: string): Promise<void> {
    const img = await this.fetchFn(imageUrl);
    if (!img.ok) throw new EtsyApiError(`Etsy: could not download product image ${imageUrl} (${img.status})`, 502);
    const blob = await img.blob();
    const form = new FormData();
    form.append('image', blob, imageUrl.split('/').pop()?.split('?')[0] || 'image.jpg');
    form.append('rank', '1');
    await this.request('POST', `${this.shopPath}/listings/${listingId}/images`, { multipart: form });
  }

  private indexSkus(listings: EtsyListing[]) {
    for (const l of listings) {
      const skus = l.inventory?.products.filter((p) => !p.is_deleted).map((p) => p.sku) ?? l.skus ?? [];
      for (const sku of skus) if (sku) this.skuIndex.set(sku, String(l.listing_id));
    }
  }

  /** SKU → listing_id, scanning the shop once per client. */
  async findListingIdBySku(sku: string): Promise<string | null> {
    const hit = this.skuIndex.get(sku);
    if (hit || this.skuIndexComplete) return hit ?? null;
    let cursor: string | undefined;
    do {
      cursor = (await this.listProducts({ cursor })).nextCursor;
    } while (cursor);
    this.skuIndexComplete = true;
    return this.skuIndex.get(sku) ?? null;
  }

  // ── Inventory ───────────────────────────────────────────────────────────

  async listInventory(params: { limit?: number } = {}): Promise<MarketInventoryItem[]> {
    const max = params.limit ?? Infinity;
    const out: MarketInventoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listProducts({ cursor });
      out.push(...page.items.filter((p) => p.sku).map((p) => ({ sku: p.sku, quantity: p.quantity })));
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out.slice(0, max === Infinity ? undefined : max);
  }

  /** Changes only this SKU's quantity; other variants and prices stay as they are. */
  async updateInventory(sku: string, quantity: number): Promise<void> {
    const listingId = await this.findListingIdBySku(sku);
    if (!listingId) throw new EtsyApiError(`Etsy: no listing has SKU ${sku}`, 404);
    const { data } = await this.request<EtsyInventory>('GET', `/listings/${listingId}/inventory`);
    await this.request('PUT', `/listings/${listingId}/inventory`, { json: inventoryWriteBody(data!, { sku, quantity }) });
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  /** Receipts in a created/modified window (Etsy filters on epoch seconds). */
  async listOrders(params: { from?: Date; to?: Date; limit?: number; by?: 'created' | 'modified' } = {}): Promise<MarketOrder[]> {
    const max = Math.min(params.limit ?? 1000, 1000);
    const sec = (d?: Date) => (d ? Math.floor(d.getTime() / 1000) : undefined);
    const [minKey, maxKey] = params.by === 'modified' ? ['min_last_modified', 'max_last_modified'] : ['min_created', 'max_created'];

    const out: MarketOrder[] = [];
    let offset = 0;
    while (out.length < max) {
      const { data } = await this.request<{ count?: number; results?: EtsyReceipt[] }>('GET', `${this.shopPath}/receipts`, {
        query: { [minKey]: sec(params.from), [maxKey]: sec(params.to), limit: Math.min(PAGE_MAX, max - out.length), offset },
      });
      const receipts = data?.results ?? [];
      out.push(...receipts.map((r) => mapEtsyReceipt(r, this.opts.channelId)));
      offset += receipts.length;
      if (receipts.length === 0 || offset >= (data?.count ?? 0)) break;
    }
    return out;
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    const { data } = await this.request<EtsyReceipt>('GET', `${this.shopPath}/receipts/${encodeURIComponent(externalOrderId)}`);
    return mapEtsyReceipt(data!, this.opts.channelId);
  }

  /**
   * Same shape as EbayClient.createShippingFulfillment so lib/marketplace/fulfillment.ts
   * can drive either. Etsy confirms shipment per receipt, so `lineItems` is ignored.
   */
  async createShippingFulfillment(input: {
    orderId: string;
    trackingNumber: string;
    shippingCarrierCode: string;
    lineItems?: Array<{ lineItemId: string; quantity: number }>;
  }): Promise<void> {
    await this.request('POST', `${this.shopPath}/receipts/${encodeURIComponent(input.orderId)}/tracking`, {
      form: { tracking_code: input.trackingNumber, carrier_name: input.shippingCarrierCode.toLowerCase() },
    });
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    await this.createShippingFulfillment({
      orderId: externalOrderId,
      trackingNumber,
      shippingCarrierCode: this.opts.defaultCarrier ?? ETSY_DEFAULT_CARRIER_FALLBACK,
    });
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', this.shopPath);
      return true;
    } catch {
      return false;
    }
  }
}
