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

import { Hono } from 'hono';
import type { HonoEnv } from '../../types';
import { authMiddleware, adminOnly } from '../../middleware/auth';
import { connectRoutes } from './connect';
import { webhookRoutes } from './webhook';
import { syncRoutes } from './sync-products';
import { statusRoutes } from './status';
import { marketplaceOrderRoutes } from './orders';

/**
 * Unified marketplace routes mounted at /v1/marketplace.
 *
 * Routes:
 *   POST   /v1/marketplace/connect/:platform      — Initiate OAuth flow
 *   GET    /v1/marketplace/connect/:platform/callback — OAuth callback
 *   POST   /v1/marketplace/webhook/:platform       — Receive webhook events
 *   POST   /v1/marketplace/:channelId/sync/products — Trigger product sync
 *   POST   /v1/marketplace/:channelId/sync/inventory — Trigger inventory sync
 *   GET    /v1/marketplace/:channelId/status        — Channel health check
 *   POST   /v1/marketplace/:channelId/orders/import — Pull orders now
 *   POST   /v1/marketplace/:channelId/orders/:orderId/shipment — Confirm shipment on the marketplace
 */

export function marketplaceRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // Webhook receivers: public on purpose (marketplaces can't present our
  // credentials). eBay notifications are ECDSA-verified before anything is
  // recorded; other platforms answer 501. See ./webhook.ts.
  app.route('/webhook', webhookRoutes());

  // Everything else is admin-only: Better Auth admin session or sk_ key.
  // This includes the OAuth callback; the admin's browser carries the session
  // cookie on the redirect back from the marketplace, and the single-use state
  // is checked on top of that.
  const admin = new Hono<HonoEnv>();
  admin.use('*', authMiddleware, adminOnly);
  admin.route('/connect', connectRoutes());
  admin.route('/:channelId/sync', syncRoutes());
  admin.route('/:channelId/status', statusRoutes());
  admin.route('/:channelId/orders', marketplaceOrderRoutes());
  app.route('/', admin);

  return app;
}
