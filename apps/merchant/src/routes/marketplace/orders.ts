import { Hono } from 'hono';
import { getDb } from '../../db';
import { ApiError, uuid, type HonoEnv } from '../../types';
import { clientForChannel, loadChannel } from '../../lib/marketplace/channel';
import { orderImportSummary, runOrderImport } from '../../lib/marketplace/sync-jobs';
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

export function marketplaceOrderRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.post('/import', async (c) => {
    const db = getDb(c.var.db);
    const channelId = c.req.param('channelId')!;
    const body = (await c.req.json().catch(() => ({}))) as { since?: unknown; limit?: unknown };

    const channel = await loadChannel(db, channelId);
    const client = clientForChannel(db, c.env, channel);

    let since: Date | undefined;
    if (body.since !== undefined) {
      since = new Date(String(body.since));
      if (Number.isNaN(since.getTime())) throw ApiError.invalidRequest('since must be an ISO 8601 date');
    }
    const limit = body.limit === undefined ? undefined : Number(body.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw ApiError.invalidRequest('limit must be a positive integer');

    const jobId = uuid();
    await db.run(
      `INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status, payload, attempts) VALUES (?, ?, 'pull_orders', 'in_progress', ?, 1)`,
      [jobId, channelId, JSON.stringify({ since: since?.toISOString() ?? null, limit: limit ?? null })],
    );

    try {
      const { from, result } = await runOrderImport(db, client, channel, { since, limit });
      await db.run(`UPDATE marketplace_sync_jobs SET status = 'completed', payload = ?, updated_at = datetime('now') WHERE id = ?`, [
        JSON.stringify({ orders: orderImportSummary(from, result) }),
        jobId,
      ]);
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
