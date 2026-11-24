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
 * eBay Sell API client implementing IMarketplaceClient.
 *
 *   Inventory API   /sell/inventory/v1    inventory items (keyed by SKU) and offers
 *   Fulfillment API /sell/fulfillment/v1  orders and shipping fulfillments
 *
 * Identity: the external product ID is the SKU. One inventory item per variant,
 * matching the variant-level marketplace_product_mappings rows.
 *
 * Listing: an inventory item alone is not visible on eBay. When `listing` is
 * configured (category + business policies + location), upsertProduct also
 * creates/updates the offer, publishes it for active products, and withdraws
 * (ends) the listing when the product becomes draft/inactive.
 *
 * Tokens come from an EbayTokenProvider (see ebay-oauth.ts). A 401 triggers one
 * forced refresh and a retry. `fetch` is injectable for tests.
 */

import type { IMarketplaceClient, MarketProduct, MarketInventoryItem, MarketOrder } from './types';
import { ebayHosts, type EbayEnvironment, type EbayTokenProvider } from './ebay-oauth';
import { resolveBuyerEmail } from './buyer';

export interface EbayListingConfig {
  categoryId: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

export interface EbayClientOptions {
  tokens: EbayTokenProvider;
  environment?: EbayEnvironment;
  /** X-EBAY-C-MARKETPLACE-ID, e.g. EBAY_US, EBAY_GB. Default EBAY_US. */
  marketplaceId?: string;
  /** Content-Language for inventory/offer writes. Default en-US. */
  contentLanguage?: string;
  /** Currency for offer prices when the product carries none. Default USD. */
  currency?: string;
  condition?: 'NEW' | 'USED_EXCELLENT' | 'USED_GOOD' | 'NEW_OTHER';
  listing?: EbayListingConfig;
  /** eBay carrier code used by updateShipment (e.g. USPS, UPS, FEDEX, ROYAL_MAIL). */
  defaultShippingCarrierCode?: string;
  /** Used for channelStoreId on mapped orders. */
  channelId?: string;
  rateLimiter?: { acquire(platform: string): Promise<boolean> };
  fetch?: typeof fetch;
}

export class EbayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: Array<{ errorId?: number; message?: string }> = [],
  ) {
    super(message);
    this.name = 'EbayApiError';
  }
}

// ─── eBay wire types (only the fields we read) ───────────────────────────────

interface EbayAmount {
  value: string;
  currency: string;
}

interface EbayInventoryItem {
  sku: string;
  condition?: string;
  product?: { title?: string; description?: string; imageUrls?: string[] };
  availability?: { shipToLocationAvailability?: { quantity?: number } };
  packageWeightAndSize?: { weight?: { value?: number; unit?: string } };
}

interface EbayOffer {
  offerId: string;
  sku: string;
  marketplaceId: string;
  status?: 'PUBLISHED' | 'UNPUBLISHED';
  pricingSummary?: { price?: EbayAmount };
  listing?: { listingId?: string };
}

interface EbayAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  countryCode?: string;
}

export interface EbayOrder {
  orderId: string;
  creationDate?: string;
  orderFulfillmentStatus?: string;
  orderPaymentStatus?: string;
  cancelStatus?: { cancelState?: string };
  buyer?: {
    username?: string;
    buyerRegistrationAddress?: { fullName?: string; email?: string };
  };
  pricingSummary?: {
    priceSubtotal?: EbayAmount;
    deliveryCost?: EbayAmount;
    tax?: EbayAmount;
    total?: EbayAmount;
  };
  lineItems?: Array<{
    lineItemId: string;
    sku?: string;
    title?: string;
    quantity?: number;
    lineItemCost?: EbayAmount;
  }>;
  fulfillmentStartInstructions?: Array<{
    shippingStep?: {
      shipTo?: {
        fullName?: string;
        email?: string;
        primaryPhone?: { phoneNumber?: string };
        contactAddress?: EbayAddress;
      };
    };
  }>;
}

// ─── Money ───────────────────────────────────────────────────────────────────

/** "12.34" → 1234. Parses the decimal string directly (no float drift). */
export function ebayAmountToCents(amount: EbayAmount | undefined): number {
  if (!amount?.value) return 0;
  const m = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(amount.value.trim());
  if (!m) return Math.round(Number(amount.value) * 100) || 0;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function centsToEbayAmount(cents: number, currency: string): EbayAmount {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return { value: `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`, currency };
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

export function mapEbayOrder(order: EbayOrder, channelStoreId = ''): MarketOrder {
  const items = (order.lineItems ?? []).map((li) => {
    const qty = li.quantity ?? 1;
    return {
      sku: li.sku ?? '',
      title: li.title ?? '',
      qty,
      // lineItemCost is the line total (price × quantity).
      unitPriceCents: qty > 0 ? Math.round(ebayAmountToCents(li.lineItemCost) / qty) : 0,
      externalLineItemId: li.lineItemId,
    };
  });

  const p = order.pricingSummary ?? {};
  const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const addr = shipTo?.contactAddress;

  return {
    externalOrderId: order.orderId,
    platform: 'ebay',
    channelStoreId,
    customerEmail: resolveBuyerEmail(order.buyer?.buyerRegistrationAddress?.email ?? shipTo?.email, order.orderId),
    items,
    subtotalCents: p.priceSubtotal ? ebayAmountToCents(p.priceSubtotal) : items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0),
    taxCents: ebayAmountToCents(p.tax),
    shippingCents: ebayAmountToCents(p.deliveryCost),
    totalCents: ebayAmountToCents(p.total),
    currency: p.total?.currency ?? p.priceSubtotal?.currency ?? 'USD',
    status: order.orderFulfillmentStatus ?? 'NOT_STARTED',
    ...(order.orderPaymentStatus && { paymentStatus: order.orderPaymentStatus }),
    cancelled: order.cancelStatus?.cancelState === 'CANCELED',
    ...(addr && {
      shippingAddress: {
        name: shipTo?.fullName ?? '',
        line1: addr.addressLine1 ?? '',
        ...(addr.addressLine2 && { line2: addr.addressLine2 }),
        city: addr.city ?? '',
        ...(addr.stateOrProvince && { state: addr.stateOrProvince }),
        postalCode: addr.postalCode ?? '',
        country: addr.countryCode ?? '',
        ...(shipTo?.primaryPhone?.phoneNumber && { phone: shipTo.primaryPhone.phoneNumber }),
      },
    }),
    createdAt: order.creationDate ?? new Date().toISOString(),
  };
}

function mapInventoryItem(item: EbayInventoryItem, offer?: EbayOffer): MarketProduct {
  const weight = item.packageWeightAndSize?.weight;
  const grams =
    weight?.value === undefined
      ? 0
      : Math.round(weight.value * ({ GRAM: 1, KILOGRAM: 1000, OUNCE: 28.3495, POUND: 453.592 }[weight.unit ?? 'GRAM'] ?? 1));
  return {
    id: item.sku,
    sku: item.sku,
    title: item.product?.title ?? '',
    description: item.product?.description ?? '',
    priceCents: ebayAmountToCents(offer?.pricingSummary?.price),
    currency: offer?.pricingSummary?.price?.currency ?? 'USD',
    imageUrl: item.product?.imageUrls?.[0] ?? null,
    quantity: item.availability?.shipToLocationAvailability?.quantity ?? 0,
    weightG: grams,
    requiresShipping: true,
    status: offer?.status === 'PUBLISHED' ? 'active' : 'draft',
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

type Query = Record<string, string | number | undefined>;

export class EbayClient implements IMarketplaceClient {
  readonly platform = 'ebay' as const;
  /** Non-secret settings (tokens never live here). */
  readonly config: Record<string, unknown>;

  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: EbayClientOptions) {
    this.base = ebayHosts(opts.environment).api;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.config = {
      environment: opts.environment ?? 'production',
      marketplaceId: this.marketplaceId,
      contentLanguage: this.contentLanguage,
      listing: opts.listing ?? null,
    };
  }

  private get marketplaceId() {
    return this.opts.marketplaceId ?? 'EBAY_US';
  }
  private get contentLanguage() {
    return this.opts.contentLanguage ?? 'en-US';
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    init: { query?: Query; body?: unknown; allowStatus?: number[] } = {},
  ): Promise<{ status: number; data: T | null }> {
    if (this.opts.rateLimiter && !(await this.opts.rateLimiter.acquire('ebay'))) {
      throw new EbayApiError('eBay: rate limit exceeded (local quota)', 429);
    }

    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));

    const send = async (token: string) =>
      this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': this.marketplaceId,
          ...(init.body !== undefined && { 'Content-Type': 'application/json', 'Content-Language': this.contentLanguage }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });

    let res = await send(await this.opts.tokens.getAccessToken());
    if (res.status === 401) res = await send(await this.opts.tokens.refresh());

    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;

    if (!res.ok && !init.allowStatus?.includes(res.status)) {
      const errors = ((data as { errors?: EbayApiError['errors'] } | null)?.errors ?? []);
      const detail = errors.map((e) => e.message).filter(Boolean).join('; ');
      throw new EbayApiError(`eBay ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status, errors);
    }
    return { status: res.status, data: res.ok ? (data as T) : null };
  }

  private skuPath(sku: string) {
    return `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async refreshTokens(): Promise<void> {
    await this.opts.tokens.refresh();
  }

  getAccessToken(): Promise<string> {
    return this.opts.tokens.getAccessToken();
  }

  // ── Products ────────────────────────────────────────────────────────────

  /** cursor = offset into the seller's inventory items. */
  async listProducts(params: { limit?: number; cursor?: string } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
    const offset = Number(params.cursor ?? 0) || 0;
    const { data } = await this.request<{ inventoryItems?: EbayInventoryItem[]; total?: number; next?: string }>(
      'GET',
      '/sell/inventory/v1/inventory_item',
      { query: { limit, offset } },
    );
    const items = (data?.inventoryItems ?? []).map((i) => mapInventoryItem(i));
    const nextOffset = offset + items.length;
    return {
      items,
      ...(data?.next && items.length > 0 && { nextCursor: String(nextOffset) }),
    };
  }

  async getProduct(sku: string): Promise<MarketProduct> {
    const { data } = await this.request<EbayInventoryItem>('GET', this.skuPath(sku));
    return mapInventoryItem({ ...data!, sku }, await this.findOffer(sku));
  }

  /** Creates or replaces the inventory item; with `listing` config, also the offer. Returns the SKU. */
  async upsertProduct(product: MarketProduct): Promise<string> {
    await this.request('PUT', this.skuPath(product.sku), {
      body: {
        condition: this.opts.condition ?? 'NEW',
        availability: { shipToLocationAvailability: { quantity: Math.max(0, product.quantity) } },
        product: {
          title: product.title.slice(0, 80), // eBay's title limit
          description: product.description,
          imageUrls: product.imageUrl ? [product.imageUrl] : [],
        },
        ...(product.weightG > 0 && {
          packageWeightAndSize: { weight: { value: product.weightG, unit: 'GRAM' } },
        }),
      },
    });

    const listing = this.opts.listing;
    if (!listing) return product.sku;

    const offerBody = {
      sku: product.sku,
      marketplaceId: this.marketplaceId,
      format: 'FIXED_PRICE',
      availableQuantity: Math.max(0, product.quantity),
      categoryId: listing.categoryId,
      listingDescription: product.description,
      merchantLocationKey: listing.merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId: listing.fulfillmentPolicyId,
        paymentPolicyId: listing.paymentPolicyId,
        returnPolicyId: listing.returnPolicyId,
      },
      pricingSummary: { price: centsToEbayAmount(product.priceCents, product.currency || this.opts.currency || 'USD') },
    };

    const existing = await this.findOffer(product.sku);
    let offerId: string;
    if (existing) {
      offerId = existing.offerId;
      await this.request('PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { body: offerBody });
    } else {
      const { data } = await this.request<{ offerId: string }>('POST', '/sell/inventory/v1/offer', { body: offerBody });
      offerId = data!.offerId;
    }

    const published = existing?.status === 'PUBLISHED';
    if (product.status === 'active' && !published) {
      await this.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, { body: {} });
    } else if (product.status !== 'active' && published) {
      // Ends the listing but keeps the offer, so re-activating republishes it.
      await this.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, { body: {} });
    }
    return product.sku;
  }

  /** Deleting the inventory item also ends its offers/listings on eBay. */
  async deleteProduct(sku: string): Promise<void> {
    await this.request('DELETE', this.skuPath(sku), { allowStatus: [404] });
  }

  private async findOffer(sku: string): Promise<EbayOffer | undefined> {
    const { data } = await this.request<{ offers?: EbayOffer[] }>('GET', '/sell/inventory/v1/offer', {
      query: { sku, marketplace_id: this.marketplaceId },
      allowStatus: [404], // eBay answers 404 when the SKU has no offers
    });
    return data?.offers?.find((o) => o.marketplaceId === this.marketplaceId);
  }

  // ── Inventory ───────────────────────────────────────────────────────────

  async listInventory(params: { limit?: number } = {}): Promise<MarketInventoryItem[]> {
    const max = params.limit ?? Infinity;
    const out: MarketInventoryItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listProducts({ limit: Math.min(200, max - out.length), cursor });
      out.push(...page.items.map((p) => ({ sku: p.sku, quantity: p.quantity })));
      cursor = page.nextCursor;
    } while (cursor && out.length < max);
    return out;
  }

  /**
   * Sets available quantity without touching the rest of the item (a PUT on
   * inventory_item would replace title/description/images too).
   */
  async updateInventory(sku: string, quantity: number): Promise<void> {
    const { data } = await this.request<{ responses?: Array<{ sku?: string; statusCode?: number; errors?: EbayApiError['errors'] }> }>(
      'POST',
      '/sell/inventory/v1/bulk_update_price_quantity',
      { body: { requests: [{ sku, shipToLocationAvailability: { quantity: Math.max(0, quantity) } }] } },
    );
    const result = data?.responses?.find((r) => r.sku === sku) ?? data?.responses?.[0];
    if (result?.statusCode && result.statusCode >= 300) {
      const detail = (result.errors ?? []).map((e) => e.message).join('; ');
      throw new EbayApiError(`eBay updateInventory failed for ${sku} (${result.statusCode})${detail ? `: ${detail}` : ''}`, result.statusCode, result.errors);
    }
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  /** `by: 'modified'` filters on lastmodifieddate, which catches orders paid after creation. */
  async listOrders(params: { from?: Date; to?: Date; limit?: number; by?: 'created' | 'modified' } = {}): Promise<MarketOrder[]> {
    const max = Math.min(params.limit ?? 1000, 1000);
    const filter =
      params.from || params.to
        ? `${params.by === 'modified' ? 'lastmodifieddate' : 'creationdate'}:[${params.from?.toISOString() ?? ''}..${params.to?.toISOString() ?? ''}]`
        : undefined;

    const out: MarketOrder[] = [];
    let offset = 0;
    while (out.length < max) {
      const { data } = await this.request<{ orders?: EbayOrder[]; next?: string }>('GET', '/sell/fulfillment/v1/order', {
        query: { filter, limit: Math.min(200, max - out.length), offset },
      });
      const orders = data?.orders ?? [];
      out.push(...orders.map((o) => mapEbayOrder(o, this.opts.channelId)));
      if (!data?.next || orders.length === 0) break;
      offset += orders.length;
    }
    return out;
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    return mapEbayOrder(await this.getRawOrder(externalOrderId), this.opts.channelId);
  }

  private async getRawOrder(orderId: string): Promise<EbayOrder> {
    const { data } = await this.request<EbayOrder>('GET', `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`);
    return data!;
  }

  /**
   * Marks lines as shipped. With no explicit `lineItems`, ships every line of
   * the order at its full quantity.
   */
  async createShippingFulfillment(input: {
    orderId: string;
    trackingNumber: string;
    shippingCarrierCode: string;
    lineItems?: Array<{ lineItemId: string; quantity: number }>;
    shippedDate?: Date;
  }): Promise<void> {
    const lineItems =
      input.lineItems ??
      (await this.getRawOrder(input.orderId)).lineItems?.map((li) => ({ lineItemId: li.lineItemId, quantity: li.quantity ?? 1 })) ??
      [];
    if (lineItems.length === 0) throw new Error(`eBay: order ${input.orderId} has no line items to ship`);

    const path = `/sell/fulfillment/v1/order/${encodeURIComponent(input.orderId)}/shipping_fulfillment`;
    await this.request('POST', path, {
      body: {
        lineItems,
        shippedDate: (input.shippedDate ?? new Date()).toISOString(),
        shippingCarrierCode: input.shippingCarrierCode,
        trackingNumber: input.trackingNumber,
      },
    });
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    const carrier = this.opts.defaultShippingCarrierCode;
    if (!carrier) throw new Error('eBay: set defaultShippingCarrierCode, or call createShippingFulfillment with a carrier');
    await this.createShippingFulfillment({ orderId: externalOrderId, trackingNumber, shippingCarrierCode: carrier });
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /** True when the token works and the Inventory API answers. */
  async healthCheck(): Promise<boolean> {
    try {
      await this.request('GET', '/sell/inventory/v1/inventory_item', { query: { limit: 1 } });
      return true;
    } catch {
      return false;
    }
  }
}
