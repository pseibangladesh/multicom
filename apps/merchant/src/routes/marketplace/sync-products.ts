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
import { ApiError, uuid } from '../../types';

/**
 * Sync trigger routes (admin auth required).
 *
 * POST /v1/marketplace/:channelId/sync/products — Trigger product sync to marketplace.
 * POST /v1/marketplace/:channelId/sync/inventory — Trigger inventory sync.
 */

export function syncRoutes(): Hono {
  const app = new Hono();

  // ── POST /:channelId/sync/products ──────────────────────────────────────

  app.post('/products', async (c) => {
    const db = getDb(c.var.db);
    const channelId = c.req.param('channelId');

    // Validate API key auth.
    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!apiKey) throw ApiError.unauthorized('API key required');

    const keyHash = await hashKey(apiKey);
    const keyRow = await db.query<{ role: string }>(
      `SELECT role FROM api_keys WHERE key_hash = ?`,
      [keyHash],
    );

    if (keyRow.length === 0 || keyRow[0].role !== 'admin') {
      throw ApiError.unauthorized('Invalid or non-admin API key');
    }

    // Verify channel exists and is active.
    const channel = await db.query<{ platform: string; status: string }>(
      `SELECT platform, status FROM marketplace_channels WHERE id = ?`,
      [channelId],
    );

    if (channel.length === 0) {
      throw ApiError.notFound('Channel not found');
    }
    if (channel[0].status !== 'active') {
      throw ApiError.invalidRequest('Channel is not active');
    }

    // Create a sync job record.
    const jobId = uuid();
    await db.run(
      `INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status) VALUES (?, ?, 'pending', 'pending')`,
      [jobId, channelId],
    );

    return c.json({ ok: true, jobId, message: 'Sync job queued' });
  });

  // ── POST /:channelId/sync/inventory ─────────────────────────────────────

  app.post('/inventory', async (c) => {
    const db = getDb(c.var.db);
    const channelId = c.req.param('channelId');

    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
    if (!apiKey) throw ApiError.unauthorized('API key required');

    const keyHash = await hashKey(apiKey);
    const keyRow = await db.query<{ role: string }>(
      `SELECT role FROM api_keys WHERE key_hash = ?`,
      [keyHash],
    );

    if (keyRow.length === 0 || keyRow[0].role !== 'admin') {
      throw ApiError.unauthorized('Invalid or non-admin API key');
    }

    const channel = await db.query<{ status: string }>(
      `SELECT status FROM marketplace_channels WHERE id = ?`,
      [channelId],
    );

    if (channel.length === 0) {
      throw ApiError.notFound('Channel not found');
    }
    if (channel[0].status !== 'active') {
      throw ApiError.invalidRequest('Channel is not active');
    }

    const jobId = uuid();
    await db.run(
      `INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status) VALUES (?, ?, 'pending', 'pending')`,
      [jobId, channelId],
    );

    return c.json({ ok: true, jobId, message: 'Inventory sync queued' });
  });

  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
