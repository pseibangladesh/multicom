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
import { getDb } from '../../db';
import { ApiError } from '../../types';
import type { HonoEnv } from '../../types';
import { enqueueSyncJob, SyncQueueError } from '../../lib/marketplace/sync-jobs';
import type { SyncJobType } from '../../lib/marketplace/types';

/**
 * Sync trigger routes (admin only: authMiddleware + adminOnly in ./index.ts).
 * Each records a job and sends it to MARKETPLACE_SYNC_QUEUE; the consumer in
 * src/workers/marketplace-consumer.ts does the work. Poll
 * GET /v1/admin/marketplace/channels (lastJob) for progress.
 *
 *   POST /v1/marketplace/:channelId/sync/products   push the catalog
 *   POST /v1/marketplace/:channelId/sync/inventory  push stock levels of listed variants
 *   POST /v1/marketplace/:channelId/sync/orders     pull orders in the background
 *   POST /v1/marketplace/:channelId/sync/all        products, then orders
 *
 * 202 { ok, jobId } when queued; 409 { error, details: { jobId } } while the
 * same job type is already queued or running; 503 when the queue is not bound.
 */

const ROUTES: Record<string, SyncJobType> = {
  products: 'push_products',
  inventory: 'push_inventory',
  orders: 'pull_orders',
  all: 'sync_all',
};

export function syncRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  for (const [path, jobType] of Object.entries(ROUTES)) {
    app.post(`/${path}`, async (c) => {
      const db = getDb(c.var.db);
      const channelId = c.req.param('channelId')!;

      const [channel] = await db.query<{ platform: string; status: string }>(
        `SELECT platform, status FROM marketplace_channels WHERE id = ?`,
        [channelId],
      );
      if (!channel) throw ApiError.notFound('Channel not found');
      if (channel.status !== 'active') throw ApiError.invalidRequest('Channel is not active');
      if (channel.platform !== 'etsy' && channel.platform !== 'ebay') {
        throw new ApiError('not_implemented', 501, `${channel.platform} channels are not supported yet`);
      }

      try {
        const { jobId } = await enqueueSyncJob(db, c.env.MARKETPLACE_SYNC_QUEUE, channelId, jobType);
        return c.json({ ok: true, jobId, jobType, status: 'pending' }, 202);
      } catch (err) {
        if (!(err instanceof SyncQueueError)) throw err;
        if (err.code === 'job_already_running') {
          throw new ApiError('conflict', 409, err.message, { jobId: err.existingJobId });
        }
        throw new ApiError('service_unavailable', 503, err.message);
      }
    });
  }

  return app;
}
