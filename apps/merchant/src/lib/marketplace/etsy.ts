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
 * Base URL: https://api.etsy.com/v3/application/
 * Auth: x-api-key header (keystring:shared_secret) + OAuth 2.0 Bearer token
 */

import type {
  IMarketplaceClient,
  MarketProduct,
  MarketInventoryItem,
  MarketOrder,
} from './types';
import { mapMarketplaceToProduct, mapMarketplaceToOrder } from './data-mapper';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Etsy OAuth access token response. */
interface EtsyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Etsy listing resource from API. */
interface EtsyListing {
  listing_id: number;
  shop_id: number;
  title: string;
  description: string;
  type: string;
  quantity: number;
  price: string;
  currency_code: string;
  images: Array<{ url_raw: string }>;
  state: string; // 'active' | 'draft' | 'inactive' | 'sold_out' | 'expired'
  category_id: number | null;
  who_made: string;
  is_supply: boolean;
  when_made: string;
  material: string[];
  processing_min: number;
  processing_max: number;
}

/** Etsy listing product (inventory item within a listing). */
interface EtsyListingProduct {
  product_id: number;
  sku: string;
  property_values: Array<{ name: string; value: string }>;
  offerings: Array<{
    price: { amount: string; divisor: number };
    quantity: number;
    is_enabled: boolean;
  }>;
}

/** Etsy receipt (order) from API. */
interface EtsyReceipt {
  receipt_id: number;
  user_id: number;
  from_customer: {
    first_name: string;
    last_name: string;
    email: string;
  };
  line_items: Array<{
    listing_product_id: number;
    "product.SKU": string;
    title: string;
    quantity: number;
    price: { amount: string; divisor: number };
  }>;
  shipping_amount: { amount: string; divisor: number };
  tax: { amount: string; divisor: number } | null;
  total_price: { amount: string; divisor: number };
  currency_code: string;
  created_timestamp: number;
  updated_timestamp: number;
  status: string;
  shipping?: {
    first_name: string;
    last_name: string;
    address_line1: string;
    address_line2?: string | null;
    city: string;
    state_province?: string;
    postal_code: string;
    country_code: string;
    phone?: string | null;
  };
  is_digital: boolean;
}

/** Etsy shipping object from receipt. */
interface EtsyShipping {
  first_name: string;
  last_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state_province: string;
  postal_code: string;
  country_code: string;
  phone: string | null;
}

// ─── EtsyClient class ────────────────────────────────────────────────────────

/**
 * Etsy API client implementing IMarketplaceClient.
 *
 * Usage:
 *   const client = new EtsyClient(config, credentialManager, rateLimiter);
 *   await client.refreshTokens();
 *   const products = await client.listProducts();
 */
export class EtsyClient implements IMarketplaceClient {
  readonly platform = 'etsy' as const;
  config: Record<string, unknown>;

  constructor(
    config: Record<string, unknown>,
    private getToken: () => Promise<string>,
    private getKey: () => Promise<string>,
    private rateLimiter: { acquire(): Promise<boolean> },
  ) {
    this.config = config;
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async refreshTokens(): Promise<void> {
    const refreshToken = this.config.refresh_token as string | undefined;
    if (!refreshToken) {
      throw new Error('Etsy: no refresh token configured');
    }

    const keystring = this.config.keystring as string;
    const sharedSecret = this.config.shared_secret as string;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key': `${keystring}:${sharedSecret}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Etsy token refresh failed: ${response.status} ${response.statusText}`);
    }

    const tokens = await response.json() as EtsyTokenResponse;

    // Update config with new access token and expiry.
    this.config.access_token = tokens.access_token;
    this.config.refresh_token = tokens.refresh_token;
    this.config.token_expires_at = Date.now() + tokens.expires_in * 1000;
  }

  async getAccessToken(): Promise<string> {
    // Check if we need to refresh.
    const expiresAt = this.config.token_expires_at as number | undefined;
    if (expiresAt && Date.now() + 300_000 > expiresAt) {
      await this.refreshTokens();
    }

    const token = this.config.access_token as string | undefined;
    if (!token) {
      throw new Error('Etsy: no access token available');
    }
    return token;
  }

  // ── Products ────────────────────────────────────────────────────────────

  async listProducts(params?: { limit?: number }): Promise<{ items: MarketProduct[]; nextCursor?: string }> {
    const token = await this.getAccessToken();
    const shopId = this.config.shop_id as string;
    if (!shopId) throw new Error('Etsy: shop_id not configured');

    // Fetch all listings for the shop.
    const url = `https://api.etsy.com/v3/application/shops/${shopId}/listings?limit=${params?.limit ?? 100}`;

    const items: MarketProduct[] = [];
    let cursor: string | undefined;

    do {
      const fullUrl = cursor ? `${url}&cursor=${cursor}` : url;
      const result = await this.fetchWithRateLimit(url, {
        headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
      });

      if (!result.ok) {
        throw new Error(`Etsy listProducts failed: ${result.status} ${result.statusText}`);
      }

      const data = await result.json() as Record<string, unknown>;
      const listings = Array.isArray(data.results) ? data.results : [];

      for (const listing of listings) {
        try {
          const product = mapEtsyListingToProduct(listing as EtsyListing, this.config);
          items.push(product);
        } catch {
          // Skip malformed listings.
        }
      }

      // Pagination via cursor in pagination.next_url.
      const pagination = data.pagination as { next_url?: string } | undefined;
      if (pagination?.next_url) {
        const nextUrl = new URL(pagination.next_url);
        cursor = nextUrl.searchParams.get('cursor') ?? undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor && !params?.limit);

    return { items, nextCursor: cursor };
  }

  async getProduct(id: string): Promise<MarketProduct> {
    const token = await this.getAccessToken();
    const listingId = parseInt(id, 10);

    const url = `https://api.etsy.com/v3/application/listings/${listingId}`;
    const result = await this.fetchWithRateLimit(url, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
    });

    if (!result.ok) {
      throw new Error(`Etsy getProduct failed: ${result.status}`);
    }

    const data = await result.json() as EtsyListing;
    return mapEtsyListingToProduct(data, this.config);
  }

  async upsertProduct(product: MarketProduct): Promise<string> {
    const token = await this.getAccessToken();
    const shopId = this.config.shop_id as string;
    if (!shopId) throw new Error('Etsy: shop_id not configured');

    // Check if listing already exists by external_sku.
    const existingListingId = await this.findListingBySku(product.sku, token);

    let listingId: number;

    if (existingListingId) {
      // Update existing listing.
      listingId = existingListingId;
      await this.updateListing(listingId, product, token);
      await this.updateListingInventory(listingId, product, token);
    } else {
      // Create new draft listing.
      const createResult = await this.createDraftListing(product, token);
      listingId = createResult.listing_id;

      // Activate the listing.
      await this.activateListing(listingId, token);

      // Set inventory.
      await this.updateListingInventory(listingId, product, token);
    }

    return String(listingId);
  }

  async deleteProduct(externalId: string): Promise<void> {
    const token = await this.getAccessToken();
    const listingId = parseInt(externalId, 10);

    const url = `https://api.etsy.com/v3/application/listings/${listingId}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
    });
  }

  // ── Inventory ───────────────────────────────────────────────────────────

  async listInventory(params?: { limit?: number }): Promise<MarketInventoryItem[]> {
    const token = await this.getAccessToken();
    const shopId = this.config.shop_id as string;
    if (!shopId) throw new Error('Etsy: shop_id not configured');

    const url = `https://api.etsy.com/v3/application/shops/${shopId}/listings?limit=${params?.limit ?? 100}`;
    const result = await this.fetchWithRateLimit(url, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
    });

    if (!result.ok) throw new Error(`Etsy listInventory failed: ${result.status}`);

    const data = await result.json() as { results?: unknown[] };
    const listings = Array.isArray(data.results) ? data.results : [];

    const items: MarketInventoryItem[] = [];
    for (const listing of listings as unknown as EtsyListing[]) {
      try {
        const inv = await this.getListingInventory(listing.listing_id, token);
        for (const product of inv.products ?? []) {
          if (product.sku) {
            items.push({ sku: product.sku, quantity: product.offerings?.[0]?.quantity ?? 0 });
          }
        }
      } catch {
        // Skip products with errors.
      }
    }

    return items;
  }

  async updateInventory(sku: string, quantity: number): Promise<void> {
    const token = await this.getAccessToken();

    // Find the listing that contains this SKU.
    const shopId = this.config.shop_id as string;
    if (!shopId) throw new Error('Etsy: shop_id not configured');

    const listingsResult = await fetch(
      `https://api.etsy.com/v3/application/shops/${shopId}/listings?limit=100`,
      { headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` } },
    );

    if (!listingsResult.ok) throw new Error(`Etsy updateInventory failed: ${listingsResult.status}`);
    const listingsData = await listingsResult.json() as { results?: unknown[] };
    const listings = Array.isArray(listingsData.results) ? listingsData.results : [];

    for (const listing of listings as unknown as EtsyListing[]) {
      const inv = await this.getListingInventory(listing.listing_id, token);
      const prod = inv.products?.find((p: EtsyListingProduct) => p.sku === sku);
      if (prod) {
        await this.updateListingInventory(listing.listing_id, {
          id: '',
          sku,
          title: '',
          description: '',
          priceCents: 0,
          currency: 'USD',
          quantity,
          weightG: 0,
          requiresShipping: true,
          status: 'active',
        } as MarketProduct, token);
        return;
      }
    }

    throw new Error(`Etsy: SKU ${sku} not found in any listing`);
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  async listOrders(params?: { from?: Date; to?: Date; limit?: number }): Promise<MarketOrder[]> {
    const token = await this.getAccessToken();
    const shopId = this.config.shop_id as string;
    if (!shopId) throw new Error('Etsy: shop_id not configured');

    const url = `https://api.etsy.com/v3/application/shops/${shopId}/receipts?limit=${params?.limit ?? 25}`;
    const result = await this.fetchWithRateLimit(url, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
    });

    if (!result.ok) throw new Error(`Etsy listOrders failed: ${result.status}`);
    const data = await result.json() as { results?: unknown[] };
    const receipts = Array.isArray(data.results) ? data.results : [];

    return (receipts as unknown as EtsyReceipt[]).map((r) => mapEtsyReceiptToOrder(r, this.config));
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    const token = await this.getAccessToken();
    const receiptId = parseInt(externalOrderId, 10);

    const url = `https://api.etsy.com/v3/application/shops/${this.config.shop_id}/receipts/${receiptId}`;
    const result = await this.fetchWithRateLimit(url, {
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` },
    });

    if (!result.ok) throw new Error(`Etsy getOrder failed: ${result.status}`);
    const data = await result.json() as EtsyReceipt;
    return mapEtsyReceiptToOrder(data, this.config);
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    const token = await this.getAccessToken();
    const receiptId = parseInt(externalOrderId, 10);

    // Etsy doesn't have a direct "mark shipped" API for all order types.
    // For physical orders with shipping profiles, we update the receipt status.
    console.log(`[Etsy] Marking receipt ${receiptId} as shipped (tracking: ${trackingNumber})`);
    // TODO: Implement Etsy shipping update via receipts endpoint or external fulfillment API.
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const shopId = this.config.shop_id as string;
      if (!shopId) return false;

      const result = await fetch(
        `https://api.etsy.com/v3/application/shops/${shopId}/info`,
        { headers: { 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` } },
      );

      return result.ok;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private async fetchWithRateLimit(url: string, init?: RequestInit): Promise<Response> {
    const allowed = await this.rateLimiter.acquire();
    if (!allowed) {
      throw new Error('Etsy: rate limit exceeded');
    }
    return fetch(url, init);
  }

  private async findListingBySku(sku: string, token: string): Promise<number | null> {
    const shopId = this.config.shop_id as string;
    if (!shopId) return null;

    const result = await fetch(
      `https://api.etsy.com/v3/application/shops/${shopId}/listings?limit=100`,
      { headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` } },
    );

    if (!result.ok) return null;
    const data = await result.json() as { results?: unknown[] };
    const listings = Array.isArray(data.results) ? data.results : [];

    for (const listing of listings as unknown as EtsyListing[]) {
      try {
        const inv = await this.getListingInventory(listing.listing_id, token);
        if (inv.products?.some((p: EtsyListingProduct) => p.sku === sku)) {
          return listing.listing_id;
        }
      } catch { /* skip */ }
    }

    return null;
  }

  private async createDraftListing(product: MarketProduct, token: string): Promise<EtsyListing> {
    const shopId = this.config.shop_id as string;
    const response = await fetch(
      `https://api.etsy.com/v3/application/shops/${shopId}/listings`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': `${this.config.keystring}:${this.config.shared_secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: product.title,
          description: product.description,
          type: 'physical',
          category_id: null,
          who_made: 'i_did',
          is_supply: false,
          when_made: '2020_or_later',
          state: 'draft',
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Etsy createDraftListing failed: ${response.status}`);
    }

    return response.json() as Promise<EtsyListing>;
  }

  private async activateListing(listingId: number, token: string): Promise<void> {
    await fetch(
      `https://api.etsy.com/v3/application/shops/${this.config.shop_id}/listings/${listingId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': `${this.config.keystring}:${this.config.shared_secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: 'active' }),
      },
    );
  }

  private async updateListing(listingId: number, product: MarketProduct, token: string): Promise<void> {
    await fetch(
      `https://api.etsy.com/v3/application/shops/${this.config.shop_id}/listings/${listingId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': `${this.config.keystring}:${this.config.shared_secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: product.title,
          description: product.description,
        }),
      },
    );
  }

  private async updateListingInventory(listingId: number, product: MarketProduct, token: string): Promise<void> {
    await fetch(
      `https://api.etsy.com/v3/application/listings/${listingId}/inventory`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': `${this.config.keystring}:${this.config.shared_secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          products: [
            {
              sku: product.sku,
              property_values: [],
              offerings: [
                {
                  price: { amount: (product.priceCents / 100).toString(), divisor: 1 },
                  quantity: product.quantity,
                  is_enabled: true,
                  readiness_state_id: null,
                },
              ],
            },
          ],
        }),
      },
    );
  }

  private async getListingInventory(listingId: number, token: string): Promise<{ products: EtsyListingProduct[] }> {
    const result = await fetch(
      `https://api.etsy.com/v3/application/listings/${listingId}/inventory`,
      { headers: { Authorization: `Bearer ${token}`, 'x-api-key': `${this.config.keystring}:${this.config.shared_secret}` } },
    );

    if (!result.ok) throw new Error(`Etsy getListingInventory failed: ${result.status}`);
    return result.json() as Promise<{ products: EtsyListingProduct[] }>;
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

function mapEtsyListingToProduct(listing: EtsyListing, config: Record<string, unknown>): MarketProduct {
  const priceCents = Math.round(parseFloat(listing.price) * 100);
  const imageUrl = listing.images?.[0]?.url_raw ?? null;

  return mapMarketplaceToProduct(
    {
      id: listing.listing_id,
      title: listing.title,
      description: listing.description,
      price_cents: priceCents,
      currency: listing.currency_code ?? 'USD',
      quantity: listing.quantity ?? 0,
      image_url: imageUrl,
      status: listing.state === 'active' ? 'active' : 'draft',
    },
    { id: String(listing.listing_id), currency: listing.currency_code },
  );
}

function mapEtsyReceiptToOrder(receipt: EtsyReceipt, config: Record<string, unknown>): MarketOrder {
  const items = (receipt.line_items ?? []).map((item) => ({
    sku: item["product.SKU"] ?? '',
    title: item.title,
    qty: item.quantity,
    unitPriceCents: Math.round(parseFloat(item.price.amount) * 100),
  }));

  const shipping = receipt.shipping as EtsyShipping | undefined;

  return mapMarketplaceToOrder(
    {
      order_id: receipt.receipt_id,
      customer_email: receipt.from_customer?.email ?? '',
      line_items: items,
      subtotal_cents: items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0),
      tax_cents: receipt.tax ? Math.round(parseFloat(receipt.tax.amount) * 100) : 0,
      shipping_cents: receipt.shipping_amount ? Math.round(parseFloat(receipt.shipping_amount.amount) * 100) : 0,
      total_cents: Math.round(parseFloat(receipt.total_price.amount) * 100),
      currency: receipt.currency_code ?? 'USD',
      status: receipt.status,
      shipping_address: shipping ? {
        name: `${shipping.first_name} ${shipping.last_name}`,
        line1: shipping.address_line1,
        line2: shipping.address_line2 ?? undefined,
        city: shipping.city,
        state: shipping.state_province || undefined,
        postalCode: shipping.postal_code,
        country: shipping.country_code,
        phone: shipping.phone ?? undefined,
      } : undefined,
      created_at: new Date(receipt.created_timestamp * 1000).toISOString(),
    },
    { platform: 'etsy', channelStoreId: String(config.shop_id) },
  );
}
