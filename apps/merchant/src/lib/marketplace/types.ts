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
 * Unified marketplace integration types shared across all platforms.
 *
 * All marketplace clients implement {@link IMarketplaceClient} so the admin layer
 * and sync engine can talk to any platform through a single interface.
 */

// ─── Platform identifiers ────────────────────────────────────────────────────

/** Supported marketplace platforms. */
export type MarketplacePlatform = 'etsy' | 'ebay' | 'amazon';

// ─── Product types ───────────────────────────────────────────────────────────

/** Unified product record across all marketplaces. */
export interface MarketProduct {
  /** Internal variant ID (UUID). */
  id: string;
  /** Stock Keeping Unit. */
  sku: string;
  /** Product title. */
  title: string;
  /** HTML/Markdown description. */
  description: string;
  /** Price in minor currency units (cents/pence). */
  priceCents: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Primary image URL, or null. */
  imageUrl: string | null;
  /** Current available quantity. */
  quantity: number;
  /** Weight in grams. */
  weightG: number;
  /** Whether this variant requires shipping. */
  requiresShipping: boolean;
  /** Lifecycle status. */
  status: 'active' | 'draft' | 'inactive';
  /** UPC/EAN/GTIN, when known (Amazon uses it to find the catalog product). */
  barcode?: string | null;
}

/** Request body for creating/updating a product via the internal API. */
export interface CreateMarketProductBody {
  sku: string;
  title: string;
  description?: string;
  priceCents: number;
  currency?: string;
  imageUrl?: string | null;
  quantity: number;
  weightG?: number;
  requiresShipping?: boolean;
}

// ─── Inventory types ─────────────────────────────────────────────────────────

/** Single inventory line. */
export interface MarketInventoryItem {
  sku: string;
  quantity: number;
}

// ─── Order types ─────────────────────────────────────────────────────────────

/** Unified order record across all marketplaces. */
export interface MarketOrder {
  /** External marketplace order ID. */
  externalOrderId: string;
  /** Source platform. */
  platform: MarketplacePlatform;
  /** Internal store / channel ID that owns this order. */
  channelStoreId: string;
  /** Customer email address. */
  customerEmail: string;
  /** Order line items. */
  items: Array<{
    sku: string;
    title: string;
    qty: number;
    unitPriceCents: number;
    /** Marketplace line item ID (needed to confirm shipment per line). */
    externalLineItemId?: string;
  }>;
  /** Subtotal before tax/shipping/discount (minor units). */
  subtotalCents: number;
  /** Tax amount (minor units). */
  taxCents: number;
  /** Shipping cost (minor units). */
  shippingCents: number;
  /** Grand total (minor units). */
  totalCents: number;
  /** ISO 4217 currency code. */
  currency: string;
  /** Current order status on the marketplace. */
  status: string;
  /** Payment state on the marketplace (eBay: PAID, PENDING, FAILED, FULLY_REFUNDED, PARTIALLY_REFUNDED). */
  paymentStatus?: string;
  /** True when the order was cancelled on the marketplace. */
  cancelled?: boolean;
  /** Shipping address, if available. */
  shippingAddress?: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
    phone?: string;
  };
  /** Order creation timestamp (ISO 8601). */
  createdAt: string;
}

// ─── Webhook types ───────────────────────────────────────────────────────────

/** Unified webhook event from any marketplace. */
export interface MarketWebhookEvent {
  /** Source platform. */
  platform: MarketplacePlatform;
  /** Event type identifier (e.g., 'order.paid', 'inventory.out_of_stock'). */
  eventType: string;
  /** URL to fetch the full resource details from the marketplace. */
  resourceUrl: string;
  /** Internal store / channel ID that triggered this event. */
  storeId: string;
  /** Raw unprocessed payload (for logging/replay). */
  rawPayload: Record<string, unknown>;
}

// ─── Sync job types ──────────────────────────────────────────────────────────

/** Type of sync operation. */
export type SyncJobType =
  | 'push_products'     // Push products to the marketplace
  | 'push_inventory'    // Push inventory levels
  | 'pull_orders'       // Pull orders from the marketplace
  | 'sync_all';         // Full bidirectional sync

/** Status of a sync job. */
export type SyncJobStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

/** A queued sync job record. */
export interface SyncJob {
  id: string;
  channelId: string;
  jobType: SyncJobType;
  status: SyncJobStatus;
  payload: Record<string, unknown>;
  errorMessage?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Client interface ────────────────────────────────────────────────────────

/**
 * Unified client interface that all marketplace implementations must satisfy.
 *
 * The admin layer and sync engine interact through this interface, remaining
 * agnostic of the underlying platform (Etsy, eBay, Amazon).
 */
export interface IMarketplaceClient {
  /** Platform identifier. */
  readonly platform: MarketplacePlatform;

  /** Current channel configuration (read-only snapshot). */
  readonly config: Record<string, unknown>;

  // ── Authentication ──────────────────────────────────────────────────────

  /**
   * Refresh access tokens if they are near expiry or have expired.
   * Must be idempotent and safe to call repeatedly.
   */
  refreshTokens(): Promise<void>;

  /**
   * Return a valid access token for API calls.
   * Throws if authentication is not configured.
   */
  getAccessToken(): Promise<string>;

  // ── Products ────────────────────────────────────────────────────────────

  listProducts(params?: { limit?: number; cursor?: string }): Promise<{
    items: MarketProduct[];
    nextCursor?: string;
  }>;

  getProduct(id: string): Promise<MarketProduct>;

  /**
   * Create or update a product on the marketplace.
   * @returns The external marketplace listing ID.
   */
  upsertProduct(product: MarketProduct): Promise<string>;

  deleteProduct(externalId: string): Promise<void>;

  // ── Inventory ───────────────────────────────────────────────────────────

  listInventory(params?: { limit?: number }): Promise<MarketInventoryItem[]>;

  updateInventory(sku: string, quantity: number): Promise<void>;

  // ── Orders ──────────────────────────────────────────────────────────────

  listOrders(params?: {
    from?: Date;
    to?: Date;
    limit?: number;
    /** Which timestamp from/to apply to. Default 'created'. */
    by?: 'created' | 'modified';
  }): Promise<MarketOrder[]>;

  getOrder(externalOrderId: string): Promise<MarketOrder>;

  /** Update shipment status for an external order. */
  updateShipment(
    externalOrderId: string,
    trackingNumber: string,
    trackingUrl?: string,
  ): Promise<void>;

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Quick health check — returns true if the client can reach the API.
   */
  healthCheck(): Promise<boolean>;
}

// ─── Shipment confirmation ───────────────────────────────────────────────────

/**
 * Pushes tracking back to the marketplace. eBay confirms per line item; Etsy
 * confirms per receipt and ignores `lineItems`.
 */
export interface ShipmentClient {
  createShippingFulfillment(input: {
    orderId: string;
    trackingNumber: string;
    shippingCarrierCode: string;
    lineItems?: Array<{ lineItemId: string; quantity: number }>;
  }): Promise<void>;
}

// ─── Credential types ────────────────────────────────────────────────────────

/** Type of credential stored for a channel. */
export type CredentialType = 'api_key' | 'oauth_token' | 'refresh_token';

/** Encrypted credential record (as stored in DB). */
export interface MarketCredential {
  id: string;
  channelId: string;
  credentialType: CredentialType;
  encryptedValue: string;
  metadata: Record<string, unknown>; // e.g., { expires_at, token_type }
  createdAt: string;
  updatedAt: string;
}
