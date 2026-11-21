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
 * Amazon SP-API client implementing IMarketplaceClient.
 * Auth layers: LWA tokens + Restricted Data Tokens + AWS Signature V4 signing
 * Base URL pattern: https://sellingpartnerapi-{region}.amazon.com
 */

import type { IMarketplaceClient, MarketProduct, MarketInventoryItem, MarketOrder } from './types';
import { mapMarketplaceToProduct, mapMarketplaceToOrder } from './data-mapper';
import { signRequestV4 } from './crypto-utils';

type AmazonRegion = 'NA' | 'EU' | 'FEA';
const REGION_HOSTS: Record<AmazonRegion, string> = {
  NA: 'sellingpartnerapi-na.amazon.com',
  EU: 'sellingpartnerapi-eu.amazon.com',
  FEA: 'sellingpartnerapi-fe.amazon.com',
};

function getRegion(): AmazonRegion {
  return (process.env.AMAZON_REGION as AmazonRegion) || 'NA';
}

interface LwaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** SHA-256 hex digest helper. */
async function sha256Hex(payload: string): Promise<string> {
  const encoded = new TextEncoder().encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Amazon SP-API client implementing IMarketplaceClient.
 *
 * Usage:
 *   const client = new AmazonClient(config, getToken, rateLimiter);
 *   await client.refreshTokens();
 *   const products = await client.listProducts();
 */
export class AmazonClient implements IMarketplaceClient {
  readonly platform = 'amazon' as const;
  config: Record<string, unknown>;

  constructor(
    config: Record<string, unknown>,
    private getToken: () => Promise<string>,
    private rateLimiter: { acquire(platform?: string): Promise<boolean> },
  ) {
    this.config = config;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private getRegion(): AmazonRegion {
    return (this.config.region as AmazonRegion) || getRegion();
  }

  private getHost(): string {
    return REGION_HOSTS[this.getRegion()];
  }

  /** Get AWS credentials from config. */
  private async getAwsCredentials(): Promise<{ accessKeyId: string; secretAccessKey: string; region: string }> {
    const ak = this.config.aws_access_key as string | undefined;
    const sk = this.config.aws_secret_key as string | undefined;
    if (!ak || !sk) throw new Error('Amazon: AWS credentials not configured');
    return { accessKeyId: ak, secretAccessKey: sk, region: this.getRegion() };
  }

  /** Get RDT (Restricted Data Token) for PII operations. Caches briefly. */
  private async getRdt(): Promise<string | null> {
    const rdt = this.config.restricted_data_token as string | undefined;
    if (rdt) return `Bearer ${rdt}`;

    // Try to fetch RDT via the Tokens API.
    try {
      const lwaToken = await this.getToken();
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:aws:unified-authorization',
        audience: 'https://sell.amazon.com',
        scope: 'https://api.amazonservices.com/orders/v2',
      });

      const result = await fetch(`https://${this.getHost()}/2021-06-30/authorizationTokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lwaToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });

      if (result.ok) {
        const data = await result.json() as { payload?: { restrictedDataToken: string } };
        this.config.restricted_data_token = data.payload?.restrictedDataToken;
        return `Bearer ${data.payload?.restrictedDataToken}`;
      }
    } catch { /* RDT unavailable — will fail on restricted calls */ }
    return null;
  }

  /** Sign and send an SP-API request with SigV4. */
  private async fetchSigned(method: string, pathname: string, body?: Record<string, unknown>): Promise<Response> {
    const host = this.getHost();
    const token = await this.getToken();
    const payload = body ? JSON.stringify(body) : '';
    const payloadHash = await sha256Hex(payload);

    const sig = await signRequestV4(
      method, host, pathname, {},
      await this.getAwsCredentials(),
      payloadHash,
    );

    const headers: Record<string, string> = {
      'x-amz-date': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '').split('.')[0] + 'Z',
      'x-amz-content-sha256': sig.contentSha256,
      Authorization: sig.authorization,
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (payload) headers['Content-Length'] = String(new TextEncoder().encode(payload).length);

    const result = await fetch(`https://${host}${pathname}`, { method, headers, body: payload });

    // Auto-refresh LWA token on 401.
    if (result.status === 401) {
      try { await this.refreshTokens(); } catch { /* ignore */ }
    }

    return result;
  }

  /** Send a signed request with optional RDT header for PII operations. */
  private async fetchSignedRestricted(method: string, pathname: string, body?: Record<string, unknown>): Promise<Response> {
    const host = this.getHost();
    const token = await this.getToken();
    const payload = body ? JSON.stringify(body) : '';
    const payloadHash = await sha256Hex(payload);

    const sig = await signRequestV4(
      method, host, pathname, {},
      await this.getAwsCredentials(),
      payloadHash,
    );

    const rdtHeader = await this.getRdt();

    const headers: Record<string, string> = {
      'x-amz-date': new Date().toISOString().replace(/\.\\d{3}Z$/, 'Z').replace(/[-:]/g, '').split('.')[0] + 'Z',
      'x-amz-content-sha256': sig.contentSha256,
      Authorization: sig.authorization,
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (rdtHeader) headers['X-Amz-security-token'] = rdtHeader.replace('Bearer ', '');

    if (payload) headers['Content-Length'] = String(new TextEncoder().encode(payload).length);

    const result = await fetch(`https://${host}${pathname}`, { method, headers, body: payload });

    if (result.status === 401) {
      try { await this.refreshTokens(); } catch { /* ignore */ }
    }

    return result;
  }

  // ── IMarketplaceClient: Authentication ──────────────────────────────────

  async refreshTokens(): Promise<void> {
    const refreshToken = this.config.refresh_token as string | undefined;
    if (!refreshToken) throw new Error('Amazon: no LWA refresh token configured');

    const clientId = this.config.client_id as string;
    const clientSecret = this.config.client_secret as string;
    if (!clientId || !clientSecret) throw new Error('Amazon: LWA credentials not configured');

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });

    const response = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });

    if (!response.ok) throw new Error(`Amazon LWA refresh failed: ${response.status}`);
    const tokens = await response.json() as LwaTokenResponse;
    this.config.access_token = tokens.access_token;
    this.config.refresh_token = tokens.refresh_token;
    this.config.token_expires_at = Date.now() + tokens.expires_in * 1000;
  }

  async getAccessToken(): Promise<string> {
    const expiresAt = this.config.token_expires_at as number | undefined;
    if (expiresAt && Date.now() + 300_000 > expiresAt) await this.refreshTokens();
    const token = this.config.access_token as string | undefined;
    if (!token) throw new Error('Amazon: no access token available');
    return token;
  }

  // ── IMarketplaceClient: Products ────────────────────────────────────────

  async listProducts(params?: { limit?: number; cursor?: string }): Promise<{ items: MarketProduct[]; nextCursor?: string }> {
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    const result = await this.fetchSigned(
      'GET', `/listings/2021-08-01/items/${this.config.seller_id}?marketplaceIds=${this.config.marketplace_id}&attributes=price,inventory`,
    );

    if (!result.ok) throw new Error(`Amazon listProducts failed: ${result.status}`);
    const data = await result.json() as { payload?: { [key: string]: unknown } };

    // Parse listings from response — Amazon returns items keyed by ASIN.
    const payload = data.payload as Record<string, unknown> | undefined;
    const productsList = (payload?.listings as Record<string, unknown>[]) ?? [];

    const items: MarketProduct[] = [];
    for (const listing of productsList) {
      try {
        const product = mapAmazonListingToProduct(listing as Record<string, unknown>, this.config);
        items.push(product);
      } catch { /* skip malformed */ }
    }

    return { items, nextCursor: params?.cursor };
  }

  async getProduct(id: string): Promise<MarketProduct> {
    const result = await this.fetchSigned(
      'GET', `/listings/2021-08-01/items/${this.config.seller_id},${id}?marketplaceIds=${this.config.marketplace_id}&attributes=price,inventory`,
    );

    if (!result.ok) throw new Error(`Amazon getProduct failed: ${result.status}`);
    const data = await result.json() as { payload?: Record<string, unknown> };
    return mapAmazonListingToProduct(data.payload as Record<string, unknown>, this.config);
  }

  async upsertProduct(product: MarketProduct): Promise<string> {
    const requiredFields: Record<string, string> = {
      seller_sku: product.sku,
      price: String(product.priceCents / 100),
      quantity: String(product.quantity),
      condition: 'NEW',
    };

    if (product.title) requiredFields.title = product.title;
    if (product.description) requiredFields.description = product.description;
    if (product.imageUrl) requiredFields.primary_image_url = product.imageUrl;
    if (product.weightG > 0) requiredFields.weight = JSON.stringify({ value: product.weightG, unit: 'GRAMS' });

    const result = await this.fetchSigned(
      'PUT', `/listings/2021-08-01/items/${this.config.seller_id},${product.sku}?marketplaceIds=${this.config.marketplace_id}`,
      requiredFields,
    );

    if (!result.ok) {
      // Item may not exist — try creating via PUT (Amazon treats PUT as create-or-update).
      throw new Error(`Amazon upsertProduct failed: ${result.status}`);
    }

    return product.sku;
  }

  async deleteProduct(externalId: string): Promise<void> {
    const result = await this.fetchSigned(
      'DELETE', `/listings/2021-08-01/items/${this.config.seller_id},${externalId}?marketplaceIds=${this.config.marketplace_id}`,
    );

    if (!result.ok && result.status !== 404) {
      throw new Error(`Amazon deleteProduct failed: ${result.status}`);
    }
  }

  // ── IMarketplaceClient: Inventory ───────────────────────────────────────

  async listInventory(params?: { limit?: number }): Promise<MarketInventoryItem[]> {
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    const result = await this.fetchSigned(
      'GET', `/inventory/v2?limit=${params?.limit ?? 25}`,
    );

    if (!result.ok) throw new Error(`Amazon listInventory failed: ${result.status}`);
    const data = await result.json() as { payload?: { inventoryUnits?: Array<{ sellerId: string; sellerSku: string; available?: number }> } };

    const units = data.payload?.inventoryUnits ?? [];
    return units.map((u) => ({ sku: u.sellerSku, quantity: u.available ?? 0 }));
  }

  async updateInventory(sku: string, quantity: number): Promise<void> {
    // Update quantity via Listings Items PATCH.
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    const result = await this.fetchSigned(
      'PATCH', `/listings/2021-08-01/items/${this.config.seller_id},${sku}?marketplaceIds=${this.config.marketplace_id}`,
      { name: sku, seller_sku: sku, quantity },
    );

    if (!result.ok) throw new Error(`Amazon updateInventory failed: ${result.status}`);
  }

  // ── IMarketplaceClient: Orders ──────────────────────────────────────────

  async listOrders(params?: { from?: Date; to?: Date; limit?: number }): Promise<MarketOrder[]> {
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    // Build time-range filter URL — Amazon's searchOrders API supports created_after/created_before.
    let pathname = '/orders/v2/orders?limit=25';
    if (params?.from) {
      pathname += `&created_after=${encodeURIComponent(params.from.toISOString())}`;
    } else {
      // Default: last 24 hours.
      const yesterday = new Date(Date.now() - 86_400_000);
      pathname += `&created_after=${encodeURIComponent(yesterday.toISOString())}`;
    }
    if (params?.to) {
      pathname += `&created_before=${encodeURIComponent(params.to.toISOString())}`;
    }
    if (params?.limit) {
      pathname = pathname.replace('limit=25', `limit=${params.limit}`);
    }

    const result = await this.fetchSigned('GET', pathname);

    if (!result.ok) throw new Error(`Amazon listOrders failed: ${result.status}`);
    const data = await result.json() as { payload?: Array<Record<string, unknown>> };

    const orders = data.payload ?? [];
    return orders.map((o) => mapAmazonOrderToOrder(o, this.config));
  }

  async getOrder(externalOrderId: string): Promise<MarketOrder> {
    // Requires RDT for PII access.
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    const result = await this.fetchSignedRestricted(
      'GET', `/orders/v2/orders/${encodeURIComponent(externalOrderId)}`,
    );

    if (!result.ok) throw new Error(`Amazon getOrder failed: ${result.status}`);
    const data = await result.json() as { payload?: Record<string, unknown> };
    return mapAmazonOrderToOrder(data.payload as Record<string, unknown>, this.config);
  }

  async updateShipment(externalOrderId: string, trackingNumber: string, _trackingUrl?: string): Promise<void> {
    // POST /orders/v2/{orderId}/shipments — requires RDT for PII.
    const allowed = await this.rateLimiter.acquire('amazon');
    if (!allowed) throw new Error('Amazon: rate limit exceeded');

    const body = {
      shipments: [{
        order_items: [{ order_item_id: '1', quantity: 1 }],
        shipping_provider_name: 'Custom',
        shipping_method: 'Standard',
        package_details: [{
          package_type: 'Package',
          length: 10, width: 10, height: 10,
          weight: { value: 1, unit: 'gram' },
        }],
      }],
    };

    const result = await this.fetchSignedRestricted(
      'POST', `/orders/v2/${encodeURIComponent(externalOrderId)}/shipments`,
      body,
    );

    if (!result.ok) {
      console.error(`[Amazon] Shipment update failed for order ${externalOrderId}: ${result.status}`);
    }
  }

  // ── IMarketplaceClient: Health ──────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      const token = await this.getToken();
      const result = await fetch(`https://${this.getHost()}/orders/v2/orders?limit=1`, {
        headers: { 'x-amz-date': new Date().toISOString().replace(/\.\\d{3}Z$/, 'Z').replace(/[-:]/g, '').split('.')[0] + 'Z' },
      });
      // 401/403 is expected without SigV4 — anything else means API is reachable.
      return result.status === 401 || result.status === 200;
    } catch {
      return false;
    }
  }
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

/** Map an Amazon Listings Items response to the internal MarketProduct type. */
function mapAmazonListingToProduct(
  external: Record<string, unknown>,
  config: Record<string, unknown>,
): MarketProduct {
  const productData = (external.listings as Record<string, unknown>[])?.[0] ?? external;
  const priceObj = productData?.price as Record<string, unknown> | undefined;
  const quantity = Number(productData?.quantity ?? productData?.seller_sku_listing_buffer ?? 0);

  return mapMarketplaceToProduct(
    {
      sku: String(productData?.seller_sku ?? external.asin ?? ''),
      title: String(productData?.name ?? productData?.title ?? ''),
      description: String(productData?.description ?? ''),
      price_cents: (() => {
        if (priceObj && typeof priceObj === 'object' && typeof priceObj.amount === 'string') {
          return Math.round(parseFloat(priceObj.amount) * 100);
        }
        if (priceObj && typeof priceObj.value === 'number') return Math.round(priceObj.value * 100);
        return 0;
      })(),
      currency: String((priceObj?.currency as string) ?? 'USD'),
      quantity,
      image_url: String(productData?.primary_image_url ?? ''),
      status: (productData?.status as string) === 'ACTIVE' ? 'active' : 'draft',
    },
    { id: String(external.asin ?? ''), currency: 'USD' },
  );
}

/** Map an Amazon Orders v2 response to the internal MarketOrder type. */
function mapAmazonOrderToOrder(
  external: Record<string, unknown>,
  config: Record<string, unknown>,
): MarketOrder {
  // Amazon returns orders at the line-item (offer) granularity.
  const lineItems = Array.isArray(external?.order_line_items)
    ? (external.order_line_items as Array<Record<string, unknown>>).map((item) => ({
        sku: String(item?.seller_sku ?? item?.product_sku ?? ''),
        title: String((item?.product_supplier_details as any)?.product_description ?? item?.title ?? ''),
        qty: Number(item?.quantity ?? 1),
        unitPriceCents: (() => {
          const p = item?.price as Record<string, unknown> | undefined;
          if (p && typeof p.amount === 'string') return Math.round(parseFloat(p.amount) * 100);
          return 0;
        })(),
      }))
    : [];

  // Amazon order-level amounts.
  const orderTotal = (() => {
    const t = external?.order_total as Record<string, unknown> | undefined;
    if (t && typeof t.amount === 'string') return Math.round(parseFloat(t.amount) * 100);
    return lineItems.reduce((s, i) => s + i.unitPriceCents * i.qty, 0);
  })();

  const shippingCost = (() => {
    const s = external?.shipping_total as Record<string, unknown> | undefined;
    if (s && typeof s.amount === 'string') return Math.round(parseFloat(s.amount) * 100);
    return 0;
  })();

  const taxAmount = (() => {
    const t = external?.tax_total as Record<string, unknown> | undefined;
    if (t && typeof t.amount === 'string') return Math.round(parseFloat(t.amount) * 100);
    return 0;
  })();

  const buyer = external?.buyer as Record<string, unknown> | undefined;
  const buyerEmail = buyer?.email as string | undefined ?? '';

  // Shipping address is only available with RDT (PII-restricted).
  const shippingAddr = (() => {
    const addr = external?.shipping_address as Record<string, unknown> | undefined;
    if (!addr) return undefined;
    return {
      name: String(addr.name ?? ''),
      line1: String(addr.street1 ?? addr.address_line1 ?? ''),
      line2: addr.street2 ? String(addr.street2) : undefined,
      city: String(addr.city ?? ''),
      state: addr.state ? String(addr.state) : undefined,
      postalCode: String(addr.postal_code ?? addr.zip ?? ''),
      country: String(addr.country ?? 'US'),
      phone: addr.phone ? String(addr.phone) : undefined,
    };
  })();

  return mapMarketplaceToOrder(
    {
      order_id: String(external?.amazon_order_id ?? external?.order_id ?? ''),
      customer_email: buyerEmail,
      line_items: lineItems.map((i) => ({ ...i, sku: i.sku })),
      subtotal_cents: orderTotal - shippingCost - taxAmount,
      tax_cents: taxAmount,
      shipping_cents: shippingCost,
      total_cents: orderTotal,
      currency: String(external?.currency ?? 'USD'),
      status: String(external?.order_status ?? 'pending'),
      created_at: String(external?.created_time ?? external?.created_at ?? Date.now()),
      shipping_address: shippingAddr,
    },
    { platform: 'amazon', channelStoreId: String(config.shop_id ?? config.channel_id ?? '') },
  );
}

