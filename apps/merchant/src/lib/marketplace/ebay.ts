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
 * Base URLs:
 *   Inventory : https://api.ebay.com/sell/inventory/v1
 *   Fulfillment: https://api.ebay.com/sell/fulfillment/v1
 *   Identity  : https://api.ebay.com/identity/v1/oauth2/token
 *
 * Auth: OAuth 2.0 dual tokens
 *   - Application token (client credentials) — for public data, 2h expiry
 *   - User token (authorization code)          — for sell/* endpoints, 2h access + ~18m refresh
 *
 * Header injection: X-EBAY-C-MARKETPLACE-ID (e.g., EBAY_US)
 */

import type {
  IMarketplaceClient,
  MarketProduct,
  MarketInventoryItem,
  MarketOrder,
} from './types';
import { mapMarketplaceToProduct, mapMarketplaceToOrder } from './data-mapper';

// ─── eBay API types ──────────────────────────────────────────────────────────

/** OAuth token response from eBay identity endpoint. */
interface EbayTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;       // seconds until expiry (2 hours for user tokens)
  token_type: string;       // "Bearer"
}

/** Application-level token response (client credentials grant). */
interface EbayAppTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** eBay inventory item from API. */
interface EbayInventoryItemApi {
  sku: string;
  title: string;
  description: string;
  primary_image_url: string;
  product?: {
    product_description?: { name?: string };
    aspects?: Record<string, string>;
  };
  listing_type?: string;
  price?: { value: string; currency: string };
  quantity?: number;
  condition?: 'NEW' | 'USED' | 'REFURBISHED';
  availability_distribution?: Array<{
    merchant_location_key: string;
    type: 'Available' | 'Preorder';
    quantity: number;
  }>;
}

/** eBay order from fulfillment API. */
interface EbayOrderApi {
  order_id: string;
  buyer?: { username: string };
  payment_instant_date?: string;
  last_paid_date?: string;
  shipping_service?: string;
  line_items?: Array<{
    sku?: string;
    title?: string;
    quantity?: number;
    unit_price?: { value: string; currency: string };
  }>;
  payment_charges?: Array<{
    type: string;
    amount: { value: string; currency: string };
  }>;
  shipping_cost?: { value: string; currency: string };
  tax?: { value: string; currency: string };
  total?: { value: string; currency: string };
  status?: string;
  created_date?: string;
}

/** eBay order status update request body. */
interface EbayShipmentUpdate {
  shipment_status_updates: Array<{
    order_id: string;
    shipping_provider_id: string;
    shipping_service: string;
    shipping_carrier?: string;
    shipping_account?: string;
    tracking_number?: string;
    expected_delivery_date?: string;
  }>;
}

/** eBay inventory create/update request body. */
interface EbayInventoryCreateBody {
  sku: string;
  price: { value: string; currency: string };
  quantity: number;
  condition: 'NEW' | 'USED' | 'REFURBISHED';
  title: string;
  description: string;
  primary_image_url?: string;
  product?: {
    product_description?: { name?: string };
    aspects?: Record<string, string>;
  };
  listing_type?: string;
  availability_distribution?: Array<{
    merchant_location_key: string;
    type: 'Available' | 'Preorder';
    quantity: number;
  }>;
}

/** Paginated inventory list response. */
interface EbayInventoryListResponse {
  inventory_items?: EbayInventoryItemApi[];
  next_page_token?: string;
  limit?: number;
  prev_page_token?: string;
}

// ─── EbayClient class ────────────────────────────────────────────────────────

/**
 * eBay API client implementing IMarketplaceClient.
 *
 * Usage:
 *   const client = new EbayClient(config, getToken, rateLimiter);
 */
export class EbayClient implements IMarketplaceClient {
  readonly platform = 'ebay' as const;
  config: Record<string, unknown>;

  constructor(
    config: Record<string, unknown>,
    private getToken: () => Promise<string>,
    private rateLimiter: { acquire(platform?: string): Promise<boolean> },
  ) {
    this.config = config;
  }

  // ── Authentication helpers ──────────────────────────────────────────────

  /** Get the marketplace ID header value (default: EBAY_US). */
  private getMarketplaceId(): string {
    return (this.config.marketplace as string) || 'EBAY_US';
  }

  /** Get the merchant location key for multi-warehouse support. */
  private getMerchantLocationKey(): string {
    const dists = this.config.availability_distributions as Array<{ merchant_location_key: string }> | undefined;
    if (dists && dists.length > 0) return dists[0].merchant_location_key;
    return 'default';
  }

  /** Build standard eBay request headers with auth + marketplace. */
  private async buildHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': this.getMarketplaceId(),
    };
  }

  // ── Authentication ──────────────────────────────────────────────────────

  async refreshTokens(): Promise<void> {
    const refreshToken = this.config.refresh_token as string | undefined;
    if (!refreshToken) {
      throw new Error('eBay: no refresh token configured');
    }

    const clientId = this.config.client_id as string;
    const clientSecret = this.config.client_secret as string;
    if (!clientId || !clientSecret) {
      throw new Error('eBay: client credentials not configured');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });

    const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new Error(`eBay token refresh failed: ${response.status} ${response.statusText}`);
    }

    const tokens = await response.json() as EbayTokenResponse;

    this.config.access_token = tokens.access_token;
    this.config.refresh_token = tokens.refresh_token;
    this.config.token_expires_at = Date.now() + tokens.expires_in * 1000;
  }

  async getAccessToken(): Promise<string> {
    const expiresAt = this.config.token_expires_at as number | undefined;
    if (expiresAt && Date.now() + 300_000 > expiresAt) {
      await this.refreshTokens();
    }

    const token = this.config.access_token as string | undefined;
    if (!token) {
      throw new Error('eBay: no access token available');
    }
    return token;
  }

  // ── IMarketplaceClient: Products ────────────────────────────────────────

  async listProducts(params?: { limit?: number; cursor?: string }): Promise<{ items: MarketProduct[]; nextCursor?: string }> {
    const token = await this.getToken();
    const marketplace = this.getMarketplaceId();
    let url = `https://api.ebay.com/sell/inventory/v1/inventory_item?marketplace_id=${marketplace}`;
    if (params?.limit) url += `&limit=${params.limit}`;
    if (params?.cursor) url += `&page_token=${params.cursor}`;

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      headers: await this.buildHeaders(),
    });

    if (!result.ok) {
      throw new Error(`eBay listProducts failed: ${result.status} ${result.statusText}`);
    }

    const data = await result.json() as { inventory_items?: unknown[]; next_page_token?: string };
    const items: MarketProduct[] = [];
    for (const raw of (data.inventory_items ?? [])) {
      try {
        const product = mapEbayInventoryToProduct(raw as Record<string, unknown>, this.config);
        items.push(product);
      } catch {
        // Skip malformed items.
      }
    }

    return {
      items,
      nextCursor: data.next_page_token,
    };
  }

  async getProduct(id: string): Promise<MarketProduct> {
    const token = await this.getToken();
    const sku = encodeURIComponent(id);
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}?marketplace_id=${this.getMarketplaceId()}`;

    const result = await fetch(url, {
      headers: await this.buildHeaders(),
    });

    if (!result.ok) {
      throw new Error(`eBay getProduct failed: ${result.status}`);
    }

    const data = await result.json() as Record<string, unknown>;
    return mapEbayInventoryToProduct(data, this.config);
  }

  async upsertProduct(product: MarketProduct): Promise<string> {
    const token = await this.getToken();
    const merchantLocationKey = this.getMerchantLocationKey();

    // Check if SKU already exists on eBay.
    const existing = await this.findItemBySku(product.sku, token);

    let skuToUse: string;

    if (existing) {
      // Update existing item via PUT.
      await this.updateInventoryItem(existing, product, token);
      skuToUse = existing;
    } else {
      // Create new inventory item via POST.
      await this.createInventoryItem(product, token);
      skuToUse = product.sku;
    }

    return skuToUse;
  }

  async deleteProduct(externalId: string): Promise<void> {
    const token = await this.getToken();
    const sku = encodeURIComponent(externalId);
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item/${sku}?marketplace_id=${this.getMarketplaceId()}`;

    const result = await fetch(url, {
      method: 'DELETE',
      headers: await this.buildHeaders(),
    });

    if (!result.ok && result.status !== 404) {
      throw new Error(`eBay deleteProduct failed: ${result.status}`);
    }
  }

  // ── IMarketplaceClient: Inventory ───────────────────────────────────────

  async listInventory(params?: { limit?: number }): Promise<MarketInventoryItem[]> {
    const result = await this.listProducts({ limit: params?.limit });
    return result.items.map((p) => ({ sku: p.sku, quantity: p.quantity }));
  }

  async updateInventory(sku: string, quantity: number): Promise<void> {
    const token = await this.getToken();

    // Check if item exists.
    const exists = await this.findItemBySku(sku, token);
    if (!exists) {
      throw new Error(`eBay: SKU ${sku} not found in any listing`);
    }

    const encodedSku = encodeURIComponent(sku);
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodedSku}?marketplace_id=${this.getMarketplaceId()}`;

    const merchantLocationKey = this.getMerchantLocationKey();

    const body: Record<string, unknown> = {
      sku,
      price: { value: '0.00', currency: (this.config.currency as string) || 'USD' },
      quantity,
      condition: 'NEW' as const,
      title: '',
      description: '',
      availability_distribution: [{
        merchant_location_key: merchantLocationKey,
        type: 'Available',
        quantity,
      }],
    };

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      method: 'PUT',
      headers: {
        ...(await this.buildHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      throw new Error(`eBay updateInventory failed: ${result.status}`);
    }
  }

  // ── IMarketplaceClient: Orders ──────────────────────────────────────────

  async listOrders(params?: { from?: Date; to?: Date; limit?: number }): Promise<MarketOrder[]> {
    const token = await this.getToken();
    const marketplace = this.getMarketplaceId();

    // Build filter with date range if provided.
    let url = `https://api.ebay.com/sell/fulfillment/v1/order?marketplace_id=${marketplace}`;
    if (params?.from) {
      url += `&filter=creationdate:[${params.from.toISOString()}]`;
    } else if (params?.to) {
      url += `&filter=creationdate:[..${params.to.toISOString()}]`;
    }
    if (params?.limit) url += `&limit=${params.limit}`;

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      headers: await this.buildHeaders(),
    });

    if (!result.ok) {
      throw new Error(`eBay listOrders failed: ${result.status}`);
    }

    const data = await result.json() as { orders?: unknown[] };
    const orders = (data.orders as unknown[]) ?? [];

    return (orders as Record<string, unknown>[]).map((o) => mapEbayOrderToOrder(o, this.config));
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    const token = await this.getToken();
    const encodedId = encodeURIComponent(externalOrderId);
    const url = `https://api.ebay.com/sell/fulfillment/v1/order/${encodedId}?marketplace_id=${this.getMarketplaceId()}`;

    const result = await fetch(url, {
      headers: await this.buildHeaders(),
    });

    if (!result.ok) {
      throw new Error(`eBay getOrder failed: ${result.status}`);
    }

    const data = await result.json() as unknown;
    return mapEbayOrderToOrder(data as Record<string, unknown>, this.config);
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    const token = await this.getToken();
    const url = `https://api.ebay.com/sell/fulfillment/v1/order/${encodeURIComponent(externalOrderId)}/status?marketplace_id=${this.getMarketplaceId()}`;

    const body: Record<string, unknown> = {
      shipment_status_updates: [{
        order_id: externalOrderId,
        shipping_provider_id: '',
        shipping_service: 'Standard',
        tracking_number: trackingNumber,
      }],
    };

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      method: 'PUT',
      headers: {
        ...(await this.buildHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      console.error(`[eBay] Shipment update failed for order ${externalOrderId}: ${result.status}`);
    }
  }

  // ── IMarketplaceClient: Health ──────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const token = await this.getToken();
      const result = await fetch('https://api.ebay.com/openapi/v1/service-check', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /** Check if an inventory item exists by SKU. Returns the SKU if found, null otherwise. */
  private async findItemBySku(sku: string, token: string): Promise<string | null> {
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item?marketplace_id=${this.getMarketplaceId()}&sku_list=${encodeURIComponent(sku)}`;

    const result = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!result.ok) return null;

    const data = await result.json() as { inventory_items?: unknown[] };
    const items = (data.inventory_items as unknown[]) ?? [];
    return (items as Record<string, unknown>[]).some((item) => item.sku === sku) ? sku : null;
  }

  /** Create a new eBay inventory item. */
  private async createInventoryItem(product: MarketProduct, token: string): Promise<void> {
    const merchantLocationKey = this.getMerchantLocationKey();
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item?marketplace_id=${this.getMarketplaceId()}`;

    const body: Record<string, unknown> = {
      sku: product.sku,
      title: product.title,
      description: product.description || 'No description',
      price: {
        value: (product.priceCents / 100).toString(),
        currency: product.currency || 'USD',
      },
      quantity: product.quantity,
      condition: 'NEW' as const,
      primary_image_url: product.imageUrl || undefined,
      availability_distribution: [{
        merchant_location_key: merchantLocationKey,
        type: 'Available',
        quantity: product.quantity,
      }],
    };

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      method: 'POST',
      headers: {
        ...(await this.buildHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      throw new Error(`eBay createInventoryItem failed: ${result.status}`);
    }
  }

  /** Update an existing eBay inventory item via PUT. */
  private async updateInventoryItem(sku: string, product: MarketProduct, token: string): Promise<void> {
    const merchantLocationKey = this.getMerchantLocationKey();
    const encodedSku = encodeURIComponent(sku);
    const url = `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodedSku}?marketplace_id=${this.getMarketplaceId()}`;

    const body: EbayInventoryCreateBody = {
      sku,
      title: product.title,
      description: product.description || '',
      price: {
        value: (product.priceCents / 100).toString(),
        currency: product.currency || 'USD',
      },
      quantity: product.quantity,
      condition: 'NEW',
      availability_distribution: [{
        merchant_location_key: merchantLocationKey,
        type: 'Available',
        quantity: product.quantity,
      }],
    };

    const allowed = await this.rateLimiter.acquire('ebay');
    if (!allowed) throw new Error('eBay: rate limit exceeded');

    const result = await fetch(url, {
      method: 'PUT',
      headers: {
        ...(await this.buildHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      throw new Error(`eBay updateInventoryItem failed: ${result.status}`);
    }
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

/** Map an eBay inventory item to the internal MarketProduct type. */
function mapEbayInventoryToProduct(
  external: Record<string, unknown>,
  _config: Record<string, unknown>,
): MarketProduct {
  const priceCents = (() => {
    const priceObj = external.price as Record<string, unknown> | undefined;
    if (priceObj && typeof priceObj === 'object' && typeof priceObj.value === 'string') {
      return Math.round(parseFloat(priceObj.value as string) * 100);
    }
    return 0;
  })();

  const currencyCode = (() => {
    const priceObj = external.price as Record<string, unknown> | undefined;
    if (priceObj && typeof priceObj === 'object' && typeof priceObj.currency === 'string') {
      return priceObj.currency as string;
    }
    return 'USD';
  })();

  return mapMarketplaceToProduct(
    {
      sku: String(external.sku ?? ''),
      title: String(external.title ?? ''),
      description: String(external.description ?? ''),
      price_cents: priceCents,
      currency: currencyCode,
      quantity: Number(external.quantity ?? 0),
      image_url: String(external.primary_image_url ?? ''),
      status: (external.listing_type as string) === 'ACTIVE' ? 'active' : 'draft',
    },
    { id: String(external.sku ?? ''), currency: 'USD' },
  );
}

/** Map an eBay order to the internal MarketOrder type. */
function mapEbayOrderToOrder(
  external: Record<string, unknown>,
  config: Record<string, unknown>,
): MarketOrder {
  const lineItems = Array.isArray(external.line_items)
    ? (external.line_items as Array<Record<string, unknown>>).map((item) => ({
        sku: String(item.sku ?? ''),
        title: String(item.title ?? ''),
        qty: Number(item.quantity ?? 1),
        unitPriceCents: (() => {
          const priceObj = item.unit_price as Record<string, unknown> | undefined;
          if (priceObj && typeof priceObj === 'object' && typeof priceObj.value === 'string') {
            return Math.round(parseFloat(priceObj.value as string) * 100);
          }
          return 0;
        })(),
      }))
    : [];

  const shippingCost = (() => {
    const sc = external.shipping_cost as Record<string, unknown> | undefined;
    if (sc && typeof sc === 'object' && typeof sc.value === 'string') {
      return Math.round(parseFloat(sc.value as string) * 100);
    }
    return 0;
  })();

  const taxAmount = (() => {
    const tx = external.tax as Record<string, unknown> | undefined;
    if (tx && typeof tx === 'object' && typeof tx.value === 'string') {
      return Math.round(parseFloat(tx.value as string) * 100);
    }
    return 0;
  })();

  const totalAmount = (() => {
    const t = external.total as Record<string, unknown> | undefined;
    if (t && typeof t === 'object' && typeof t.value === 'string') {
      return Math.round(parseFloat(t.value as string) * 100);
    }
    // Fallback: sum of line items + shipping + tax.
    const subtotal = lineItems.reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
    return subtotal + shippingCost + taxAmount;
  })();

  const currencyCode = (() => {
    const t = external.total as Record<string, unknown> | undefined;
    if (t && typeof t === 'object' && typeof t.currency === 'string') {
      return t.currency as string;
    }
    return 'USD';
  })();

  const buyerObj = external.buyer as Record<string, unknown> | undefined;
  const buyerEmail = buyerObj ? (buyerObj.email as string | undefined) : undefined;
  const buyerUsername = buyerObj ? (buyerObj.username as string | undefined) : undefined;

  return mapMarketplaceToOrder(
    {
      order_id: String(external.order_id ?? ''),
      customer_email: String(buyerUsername ?? buyerEmail ?? ''),
      line_items: lineItems.map((i) => ({ ...i, sku: i.sku })),
      subtotal_cents: lineItems.reduce((s, i) => s + i.unitPriceCents * i.qty, 0),
      tax_cents: taxAmount,
      shipping_cents: shippingCost,
      total_cents: totalAmount,
      currency: currencyCode,
      status: String(external.status ?? 'pending'),
      created_at: String(external.created_date ?? Date.now()),
    },
    { platform: 'ebay', channelStoreId: String(config.shop_id ?? config.channel_id ?? '') },
  );
}
