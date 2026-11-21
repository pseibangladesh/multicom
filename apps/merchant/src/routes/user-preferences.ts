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
import { ApiError, now, type HonoEnv } from '../types';
import { getDb } from '../db';

const adminApp = new OpenAPIHono<HonoEnv>();
adminApp.use('*', customerAuthMiddleware);

/**
 * Wishlist schema for validation
 */
const wishlistSchema = z.object({
  wishlist: z.array(z.string()).default([]),
});

/**
 * Read wishlist from customers.metadata JSON field
 */
const readWishlistFromMetadata = (metadata: string | null): string[] => {
  try {
    const parsed = metadata ? JSON.parse(metadata) : {};
    if (Array.isArray(parsed.wishlist)) return parsed.wishlist;
  } catch { /* ignore parse errors */ }
  return [];
};

/**
 * Write wishlist to customers.metadata JSON field
 */
const writeWishlistToMetadata = (metadata: string | null, wishlist: string[]): string => {
  let parsed: Record<string, unknown> = {};
  try { parsed = metadata ? JSON.parse(metadata) : {}; } catch { /* ignore */ }
  parsed.wishlist = wishlist;
  return JSON.stringify(parsed);
};

/**
 * GET /v1/me/wishlist — retrieve the user's wishlist product IDs
 * Stored in D1 customers.metadata (replaces Auth0 user_metadata).
 */
const getWishlistRoute = createRoute({
  method: 'get',
  path: '/me/wishlist',
  tags: ['User Preferences'],
  summary: 'Get user wishlist',
  responses: {
    200: {
      description: 'Wishlist retrieved',
      content: {
        'application/json': {
          schema: wishlistSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
  },
});

adminApp.openapi(getWishlistRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;

  if (!userId) throw ApiError.unauthorized('Invalid token');

  const db = getDb(c.var.db);
  const [customer] = await db.query<any>(
    `SELECT metadata FROM customers WHERE email IN (SELECT email FROM "user" WHERE id = ?) LIMIT 1`,
    [userId]
  );

  const wishlist = customer ? readWishlistFromMetadata(customer.metadata) : [];
  return c.json({ wishlist }, 200);
});

/**
 * POST /v1/me/wishlist — add a product to the wishlist
 */
const addWishlistProductRoute = createRoute({
  method: 'post',
  path: '/me/wishlist',
  tags: ['User Preferences'],
  summary: 'Add product to wishlist',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ productId: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Product added to wishlist',
      content: {
        'application/json': {
          schema: wishlistSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    500: { description: 'Internal error' },
  },
});

adminApp.openapi(addWishlistProductRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;

  if (!userId) throw ApiError.unauthorized('Invalid token');

  const { productId } = (await c.req.json()) as { productId: string };
  if (!productId) throw ApiError.invalidRequest('productId is required');

  const db = getDb(c.var.db);
  const [customer] = await db.query<any>(
    `SELECT metadata FROM customers WHERE email IN (SELECT email FROM "user" WHERE id = ?) LIMIT 1`,
    [userId]
  );

  if (!customer) throw ApiError.unauthorized('Customer not found');

  let wishlist = readWishlistFromMetadata(customer.metadata);
  if (!wishlist.includes(productId)) {
    wishlist.push(productId);
  }

  const newMetadata = writeWishlistToMetadata(customer.metadata, wishlist);
  await db.run(
    `UPDATE customers SET metadata = ?, updated_at = ? WHERE id = ?`,
    [newMetadata, now(), customer.id]
  );

  return c.json({ wishlist }, 200);
});

/**
 * DELETE /v1/me/wishlist/:productId — remove a product from the wishlist
 */
const removeWishlistProductRoute = createRoute({
  method: 'delete',
  path: '/me/wishlist/:productId',
  tags: ['User Preferences'],
  summary: 'Remove product from wishlist',
  responses: {
    200: {
      description: 'Product removed from wishlist',
      content: {
        'application/json': {
          schema: wishlistSchema,
        },
      },
    },
    401: { description: 'Unauthorized' },
    500: { description: 'Internal error' },
  },
});

adminApp.openapi(removeWishlistProductRoute, async (c) => {
  const auth = c.get('auth') as any;
  const userId = auth?.userId as string | undefined;
  const productId = c.req.param('productId');

  if (!userId) throw ApiError.unauthorized('Invalid token');
  if (!productId) throw ApiError.invalidRequest('productId is required');

  const db = getDb(c.var.db);
  const [customer] = await db.query<any>(
    `SELECT metadata FROM customers WHERE email IN (SELECT email FROM "user" WHERE id = ?) LIMIT 1`,
    [userId]
  );

  if (!customer) throw ApiError.unauthorized('Customer not found');

  let wishlist = readWishlistFromMetadata(customer.metadata);
  wishlist = wishlist.filter((id: string) => id !== productId);

  const newMetadata = writeWishlistToMetadata(customer.metadata, wishlist);
  await db.run(
    `UPDATE customers SET metadata = ?, updated_at = ? WHERE id = ?`,
    [newMetadata, now(), customer.id]
  );

  return c.json({ wishlist }, 200);
});

export { adminApp as adminUserPreferencesRouter };
