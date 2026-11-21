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

/**
 * Channel status routes (admin auth required).
 *
 * GET /v1/marketplace/:channelId/status — Health check for a connected channel.
 */

export function statusRoutes(): Hono {
  const app = new Hono();

  // ── GET /:channelId/status ──────────────────────────────────────────────

  app.get('/', async (c) => {
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

    // Get channel info.
    const channel = await db.query<{
      platform: string;
      external_shop_id: string | null;
      status: string;
      config_json: string;
    }>(
      `SELECT platform, external_shop_id, status, config_json 
       FROM marketplace_channels WHERE id = ?`,
      [channelId],
    );

    if (channel.length === 0) {
      throw ApiError.notFound('Channel not found');
    }

    const cfg = channel[0];
    const config = safeJsonParse(cfg.config_json);

    return c.json({
      ok: true,
      channelId,
      platform: cfg.platform,
      externalShopId: cfg.external_shop_id,
      status: cfg.status,
      config,
    });
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

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
