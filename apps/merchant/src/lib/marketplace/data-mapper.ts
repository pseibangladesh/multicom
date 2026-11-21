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
 * Data mapper: normalizes between internal schema and marketplace schemas.
 *
 * Each marketplace has a different data model — this module provides canonical
 * transformation functions so the sync engine doesn't need to know platform details.
 */

import type { MarketProduct, MarketOrder } from './types';

// ─── Product mapping ─────────────────────────────────────────────────────────

/**
 * Map an internal product record to a generic marketplace payload.
 * Each platform implementation calls this and then adds platform-specific fields.
 */
export function mapProductToMarketplace(
  product: MarketProduct,
): Record<string, unknown> {
  return {
    title: product.title,
    description: product.description,
    sku: product.sku,
    price_cents: product.priceCents,
    currency: product.currency,
    quantity: product.quantity,
    weight_g: product.weightG,
    image_url: product.imageUrl,
    requires_shipping: product.requiresShipping ?? true,
    status: product.status === 'active' ? 'active' : 'draft',
  };
}

/**
 * Map a generic marketplace product payload to the internal MarketProduct type.
 * The caller (platform client) fills in platform-specific fields before calling this.
 */
export function mapMarketplaceToProduct(
  external: Record<string, unknown>,
  options: {
    id?: string;
    currency?: string;
  } = {},
): MarketProduct {
  const priceCents = typeof external.price_cents === 'number'
    ? external.price_cents
    : typeof external.price === 'number'
      ? Math.round(external.price * 100)
      : 0;

  return {
    id: options.id ?? String(external.id ?? external.listing_id ?? ''),
    sku: String(external.sku ?? external.product_sku ?? ''),
    title: String(external.title ?? ''),
    description: String(external.description ?? ''),
    priceCents,
    currency: options.currency ?? 'USD',
    imageUrl: external.image_url ?? null,
    quantity: typeof external.quantity === 'number' ? external.quantity : 0,
    weightG: typeof external.weight_g === 'number' ? external.weight_g : 0,
    requiresShipping: external.requires_shipping !== false,
    status: (external.status as string) === 'active' ? 'active' : 'draft',
  };
}

// ─── Order mapping ───────────────────────────────────────────────────────────

/**
 * Map a generic marketplace order payload to the internal MarketOrder type.
 */
export function mapMarketplaceToOrder(
  external: Record<string, unknown>,
  options: {
    platform: string;
    channelStoreId: string;
  },
): MarketOrder {
  // Normalize line items regardless of marketplace structure.
  const items = Array.isArray(external.line_items)
    ? (external.line_items as Array<Record<string, unknown>>).map((item) => ({
        sku: String(item.sku ?? item.product_sku ?? ''),
        title: String(item.title ?? ''),
        qty: Number(item.quantity ?? item.qty ?? 0),
        unitPriceCents: typeof item.price_cents === 'number'
          ? item.price_cents
          : Math.round(Number(item.price ?? 0) * 100),
      }))
    : [];

  // Normalize shipping address.
  const shippingAddress = external.shipping_address
    ? normalizeShippingAddress(external.shipping_address as Record<string, unknown>)
    : undefined;

  return {
    externalOrderId: String(external.order_id ?? external.receipt_id ?? ''),
    platform: options.platform as 'etsy' | 'ebay' | 'amazon',
    channelStoreId: options.channelStoreId,
    customerEmail: String(external.customer_email ?? external.buyer_email ?? ''),
    items,
    subtotalCents: typeof external.subtotal_cents === 'number'
      ? external.subtotal_cents
      : calcSubtotal(items),
    taxCents: typeof external.tax_cents === 'number' ? external.tax_cents : 0,
    shippingCents: typeof external.shipping_cents === 'number' ? external.shipping_cents : 0,
    totalCents: typeof external.total_cents === 'number' ? external.total_cents : calcSubtotal(items),
    currency: String(external.currency ?? 'USD'),
    status: String(external.status ?? 'pending'),
    shippingAddress,
    createdAt: new Date(String(external.created_at ?? external.order_date ?? Date.now())).toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a shipping address object to the canonical shape. */
function normalizeShippingAddress(addr: Record<string, unknown>): MarketOrder['shippingAddress'] {
  return {
    name: String(addr.name ?? addr.shipping_name ?? ''),
    line1: String(addr.line1 ?? addr.address_line1 ?? addr.street1 ?? ''),
    line2: addr.line2 ? String(addr.line2) : undefined,
    city: String(addr.city ?? addr.town ?? ''),
    state: addr.state ? String(addr.state) : undefined,
    postalCode: String(addr.postal_code ?? addr.zip ?? addr.postcode ?? ''),
    country: String(addr.country ?? 'US'),
    phone: addr.phone ? String(addr.phone) : undefined,
  };
}

/** Calculate subtotal from line items (fallback). */
function calcSubtotal(items: MarketOrder['items']): number {
  return items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0);
}
