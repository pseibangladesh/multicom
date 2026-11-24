/**
 * MIT License
 *
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, to permit persons to whom the Software is
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

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { customerAuthMiddleware } from '../middleware/customer-auth';
import { getDb } from '../db';
import { resolveCustomer } from '../lib/customers';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { CartItem, CartTotals, CartResponse } from '../schemas';

const adminApp = new OpenAPIHono<HonoEnv>();
adminApp.use('*', customerAuthMiddleware);

/**
 * SavedCartSnapshot — Complete cart snapshot stored in D1 customers.metadata JSON
 * Allows reconstruction of cart without database fetch
 */
export interface SavedCartSnapshot {
  id: string;
  items: z.infer<typeof CartItem>[];
  totals: z.infer<typeof CartTotals>;
  currency: string;
  customer_email: string;
  status: 'open' | 'checked_out' | 'expired';
  expires_at: string;
  saved_at: string;
}

/**
 * Saved cart schema for responses
 */
const savedCartSchema = z.object({
  id: z.number(),
  user_id: z.string(),
  cart_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** A saved cart as the account pages show it (items and totals at save time). */
const savedCartSnapshotSchema = z.object({
  id: z.string(),
  items: z.array(z.object({ sku: z.string(), title: z.string(), qty: z.number(), unit_price_cents: z.number() })),
  totals: z.record(z.string(), z.number()),
  currency: z.string(),
  customer_email: z.string(),
  status: z.string(),
  expires_at: z.string(),
  saved_at: z.string(),
});
const savedCartsListSchema = z.object({ saved_carts: z.array(savedCartSnapshotSchema) });

/**
 * Create a SavedCartSnapshot from a full CartResponse
 */
function createCartSnapshot(cart: any): SavedCartSnapshot {
  return {
    id: cart.id,
    items: cart.items,
    totals: cart.totals,
    currency: cart.currency,
    customer_email: cart.customer_email,
    status: cart.status,
    expires_at: cart.expires_at,
    saved_at: new Date().toISOString(),
  };
}

/**
 * Read saved carts from customers.metadata JSON field
 */
const readSavedCartsFromMetadata = (metadata: string | null): SavedCartSnapshot[] => {
  try {
    const parsed = metadata ? JSON.parse(metadata) : {};
    if (Array.isArray(parsed.saved_carts)) return parsed.saved_carts;
  } catch { /* ignore parse errors */ }
  return [];
};

/**
 * Write saved carts to customers.metadata JSON field
 */
const writeSavedCartsToMetadata = (
  metadata: string | null,
  savedCarts: SavedCartSnapshot[]
): string => {
  let parsed: Record<string, unknown> = {};
  try { parsed = metadata ? JSON.parse(metadata) : {}; } catch { /* ignore */ }
  parsed.saved_carts = savedCarts;
  return JSON.stringify(parsed);
};

/**
 * GET /v1/me/saved-carts — list all saved carts for the authenticated user
 */
const getSavedCartsRoute = createRoute({
  method: 'get',
  path: '/me/saved-carts',
  tags: ['Saved Carts'],
  summary: 'List saved carts',
  responses: {
    200: {
      description: 'Saved carts retrieved',
      content: {
        'application/json': {
          schema: savedCartsListSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

adminApp.openapi(getSavedCartsRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;

  if (!userId) throw ApiError.unauthorized('Invalid token');

  const db = getDb(c.var.db);
  const customer = await resolveCustomer(db, userId);
  // Newest first. The snapshots live on the customer record, so they are the
  // same on every device the customer signs in on.
  const savedCarts = readSavedCartsFromMetadata(customer.metadata).sort((a, b) =>
    String(b.saved_at).localeCompare(String(a.saved_at)),
  );

  // Snapshot items come from stored JSON; the schema above documents them.
  return c.json({ saved_carts: savedCarts } as never, 200);
});

/**
 * POST /v1/me/saved-carts — save the current cart
 */
const savecartRoute = createRoute({
  method: 'post',
  path: '/me/saved-carts',
  tags: ['Saved Carts'],
  summary: 'Save a cart',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ cartId: z.string() }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Cart saved',
      content: {
        'application/json': {
          schema: savedCartSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    400: { description: 'Bad request' },
    500: { description: 'Internal error' },
  },
});

adminApp.openapi(savecartRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;

  if (!userId) throw ApiError.unauthorized('Invalid token');

  const { cartId } = (await c.req.json()) as { cartId: string };

  if (!cartId) throw ApiError.invalidRequest('cartId is required');

  const db = getDb(c.var.db);

  // Fetch full cart data
  const [cart] = await db.query<any>(`SELECT * FROM carts WHERE id = ?`, [cartId]);

  // Only your own cart: carts belong to the email they were created with.
  // Same 404 as a missing cart, so this can't be used to probe cart ids.
  const [owner] = await db.query<{ email: string }>(`SELECT email FROM "user" WHERE id = ?`, [userId]);
  if (
    !cart ||
    !owner ||
    String(cart.customer_email).trim().toLowerCase() !== owner.email.trim().toLowerCase()
  ) {
    throw ApiError.notFound('Cart not found');
  }

  // Fetch cart items
  const items = await db.query<any>(`SELECT * FROM cart_items WHERE cart_id = ?`, [cartId]);

  // Build cart items for snapshot
  const cartItems = items.map((i: any) => ({
    sku: i.sku,
    title: i.title,
    qty: i.qty,
    unit_price_cents: i.unit_price_cents,
  }));

  // Calculate totals
  const subtotalCents = cartItems.reduce((sum: number, item: any) => sum + item.unit_price_cents * item.qty, 0);
  const discountCents = cart.discount_amount_cents || 0;
  const shippingCents = cart.shipping_cents || 0;
  const totalCents = subtotalCents - discountCents + shippingCents;

  // Create snapshot
  const snapshot = createCartSnapshot({
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    customer_email: cart.customer_email,
    items: cartItems,
    totals: {
      subtotal_cents: subtotalCents,
      discount_cents: discountCents,
      shipping_cents: shippingCents,
      tax_cents: 0,
      total_cents: totalCents,
    },
    expires_at: cart.expires_at,
  });

  // Insert or ignore in saved_carts table
  await db.run(
    `INSERT OR IGNORE INTO saved_carts (user_id, cart_id) VALUES (?, ?)`,
    [userId, cartId]
  );

  // Update customers.metadata with full snapshot 
  const customer = await resolveCustomer(db, userId);

  if (customer) {
    const savedCartsMetadata = readSavedCartsFromMetadata(customer.metadata);
    const cartExistsIdx = savedCartsMetadata.findIndex((sc: SavedCartSnapshot) => sc.id === cartId);
    let updatedSavedCarts: SavedCartSnapshot[];

    if (cartExistsIdx >= 0) {
      updatedSavedCarts = savedCartsMetadata.map((sc: SavedCartSnapshot, idx: number) =>
        idx === cartExistsIdx ? snapshot : sc
      );
    } else {
      updatedSavedCarts = [...savedCartsMetadata, snapshot];
    }

    const newMetadata = writeSavedCartsToMetadata(customer.metadata, updatedSavedCarts);
    await db.run(
      `UPDATE customers SET metadata = ?, updated_at = ? WHERE id = ?`,
      [newMetadata, now(), customer.id]
    );
  }

  // Return DB record
  const savedCart = await db.query<any>(
    `SELECT id, user_id, cart_id, created_at, updated_at 
     FROM saved_carts 
     WHERE user_id = ? AND cart_id = ? 
     LIMIT 1`,
    [userId, cartId]
  );

  if (savedCart.length === 0) {
    throw new ApiError('internal_error', 500, 'Failed to retrieve saved cart');
  }

  return c.json(savedCart[0], 201);
});

/**
 * DELETE /v1/me/saved-carts/:cartId — remove a saved cart entry
 */
const deleteSavedCartRoute = createRoute({
  method: 'delete',
  path: '/me/saved-carts/:cartId',
  tags: ['Saved Carts'],
  summary: 'Delete a saved cart',
  responses: {
    204: { description: 'Saved cart deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Not found' },
    500: { description: 'Internal error' },
  },
});

adminApp.openapi(deleteSavedCartRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;
  const cartIdParam = c.req.param('cartId');

  if (!userId) throw ApiError.unauthorized('Invalid token');
  if (!cartIdParam) throw ApiError.invalidRequest('cartId is required');

  const db = getDb(c.var.db);

  // Verify the saved cart belongs to the user
  const savedCart = await db.query<any>(
    `SELECT id FROM saved_carts WHERE cart_id = ? AND user_id = ? LIMIT 1`,
    [cartIdParam, userId]
  );

  if (savedCart.length === 0) throw ApiError.notFound('Saved cart not found or unauthorized');

  // Delete the saved cart entry
  await db.run(
    `DELETE FROM saved_carts WHERE cart_id = ? AND user_id = ?`,
    [cartIdParam, userId]
  );

  // Update customers.metadata — remove this cart from saved carts
  const customer = await resolveCustomer(db, userId);

  if (customer) {
    const savedCartsMetadata = readSavedCartsFromMetadata(customer.metadata);
    const updatedSavedCarts = savedCartsMetadata.filter(
      (snapshot: SavedCartSnapshot) => snapshot.id !== cartIdParam
    );
    const newMetadata = writeSavedCartsToMetadata(customer.metadata, updatedSavedCarts);
    await db.run(
      `UPDATE customers SET metadata = ?, updated_at = ? WHERE id = ?`,
      [newMetadata, now(), customer.id]
    );
  }

  return c.json({ ok: true }, 200);
});

export { adminApp as adminSavedCartsRouter };
