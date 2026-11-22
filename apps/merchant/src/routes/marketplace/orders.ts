import { Hono } from 'hono';
import { getDb } from '../../db';
import { ApiError, uuid, type HonoEnv } from '../../types';
import { clientForChannel, loadChannel, updateChannelConfig } from '../../lib/marketplace/channel';
import { importOrders } from '../../lib/marketplace/order-import';
import { pushShipment } from '../../lib/marketplace/fulfillment';

/**
 * Marketplace order routes (admin only; see ./index.ts).
 *
 *   POST /:channelId/orders/import             pull orders now (manual trigger)
 *   POST /:channelId/orders/:orderId/shipment  confirm shipment on the marketplace
 *
 * The import body is optional: { since?: ISO 8601, limit?: number }. Without
 * `since` it resumes from the channel's last successful import (minus 1h of
 * overlap, which is safe because import is idempotent), or the last 30 days.
 */

const OVERLAP_MS = 60 * 60 * 1000;
const FIRST_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function marketplaceOrderRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/import', async (c) => {
    const db = getDb(c.var.db);
    const channelId = c.req.param('channelId')!;
    const body = (await c.req.json().catch(() => ({}))) as { since?: unknown; limit?: unknown };

    const channel = await loadChannel(db, channelId);
    const client = clientForChannel(db, c.env, channel);

    const startedAt = new Date();
    let from: Date;
    if (body.since !== undefined) {
      from = new Date(String(body.since));
      if (Number.isNaN(from.getTime())) throw ApiError.invalidRequest('since must be an ISO 8601 date');
    } else if (channel.config.last_order_import_at) {
      from = new Date(new Date(channel.config.last_order_import_at).getTime() - OVERLAP_MS);
    } else {
      from = new Date(startedAt.getTime() - FIRST_IMPORT_WINDOW_MS);
    }
    const limit = body.limit === undefined ? undefined : Number(body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw ApiError.invalidRequest('limit must be a positive integer');

    const jobId = uuid();
    await db.run(
      `INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status, payload, attempts) VALUES (?, ?, 'pull_orders', 'in_progress', ?, 1)`,
      [jobId, channelId, JSON.stringify({ from: from.toISOString(), limit: limit ?? null })],
    );

    try {
      const result = await importOrders(db, client, channelId, { from, limit });
      await db.run(`UPDATE marketplace_sync_jobs SET status = 'completed', payload = ?, updated_at = datetime('now') WHERE id = ?`, [
        JSON.stringify({
          from: from.toISOString(),
          fetched: result.fetched,
          imported: result.imported.length,
          skipped: result.skipped.length,
          failed: result.failed.length,
          shortfalls: result.shortfalls.length,
        }),
        jobId,
      ]);
      // Failed orders were not recorded, so keep the window where it was and
      // they are picked up again next run. A `limit` may also cut the window short.
      if (result.failed.length === 0 && limit === undefined) {
        await updateChannelConfig(db, channelId, { last_order_import_at: startedAt.toISOString() });
      }
      return c.json({ ok: true, jobId, from: from.toISOString(), ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.run(`UPDATE marketplace_sync_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`, [
        message,
        jobId,
      ]);
      throw err;
    }
  });

  app.post('/:orderId/shipment', async (c) => {
    const db = getDb(c.var.db);
    const channel = await loadChannel(db, c.req.param('channelId')!);
    const client = clientForChannel(db, c.env, channel);
    const result = await pushShipment(db, client, channel, c.req.param('orderId'));
    return c.json({ ok: true, ...result });
  });

  return app;
}
