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
import type { HonoEnv } from '../../types';
import { ebayAppFromEnv } from '../../lib/marketplace/ebay-oauth';
import {
  EBAY_ORDER_TOPICS,
  EBAY_SIGNATURE_HEADER,
  EBAY_VERIFICATION_TOKEN_PATTERN,
  EbayPublicKeyResolver,
  ebayChallengeResponse,
  verifyEbaySignature,
  type EbayNotification,
} from '../../lib/marketplace/ebay-notifications';
import { enqueueOrderPulls } from '../../lib/marketplace/sync-jobs';

/**
 * Marketplace webhook receivers, mounted at /v1/marketplace/webhook. Public on
 * purpose (marketplaces can't present our credentials); every POST is
 * signature-verified before anything is recorded or acted on.
 *
 *   GET  /ebay?challenge_code=…  eBay endpoint validation
 *   POST /ebay                   eBay Notification API (X-EBAY-SIGNATURE)
 *   POST /etsy, /amazon          501: no verified receiver; orders are pulled on the cron
 *
 * eBay order topics (ORDER_CONFIRMATION, ORDER_CANCELLATION_ACTIVITY,
 * ITEM_MARKED_SHIPPED) queue a pull_orders job for every connected eBay
 * channel. The pull is idempotent, so the notification only says "look now";
 * order data still comes from the Fulfillment API, never from the payload.
 *
 * Responses: 204 accepted (including duplicates); 412 bad signature (as eBay's
 * SDK does; eBay retries); 503 not configured, or the key lookup failed.
 */

/** eBay notifications are small; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export interface EbayNotificationEnv {
  EBAY_CLIENT_ID?: string;
  EBAY_CLIENT_SECRET?: string;
  EBAY_RU_NAME?: string;
  EBAY_ENVIRONMENT?: string;
  EBAY_VERIFICATION_TOKEN?: string;
  EBAY_NOTIFICATION_ENDPOINT?: string;
  API_BASE_URL?: string;
}

/** The exact URL registered with eBay; it is part of the challenge hash. */
export function ebayNotificationEndpoint(env: EbayNotificationEnv): string | null {
  if (env.EBAY_NOTIFICATION_ENDPOINT) return env.EBAY_NOTIFICATION_ENDPOINT;
  return env.API_BASE_URL ? `${env.API_BASE_URL.replace(/\/+$/, '')}/v1/marketplace/webhook/ebay` : null;
}

// One resolver per isolate and app, so the key + token caches survive between requests.
const resolvers = new Map<string, EbayPublicKeyResolver>();

export function webhookRoutes(deps: { fetch?: typeof fetch } = {}): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/ebay', async (c) => {
    const code = c.req.query('challenge_code');
    if (!code) return c.json({ error: 'challenge_code is required' }, 400);
    const token = c.env.EBAY_VERIFICATION_TOKEN;
    const endpoint = ebayNotificationEndpoint(c.env);
    if (!token || !EBAY_VERIFICATION_TOKEN_PATTERN.test(token) || !endpoint) {
      return c.json({ error: 'eBay notifications are not configured' }, 503);
    }
    return c.json({ challengeResponse: await ebayChallengeResponse(code, token, endpoint) }, 200);
  });

  app.post('/ebay', async (c) => {
    const ebay = ebayAppFromEnv(c.env);
    if (!ebay) return c.json({ error: 'eBay app is not configured' }, 503);

    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);
    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_BYTES) return c.json({ error: 'payload too large' }, 413);

    const resolverKey = `${ebay.environment}:${ebay.clientId}`;
    let resolver = resolvers.get(resolverKey);
    if (!resolver || deps.fetch) {
      resolver = new EbayPublicKeyResolver(ebay, { kv: c.env.KV_CACHE, fetch: deps.fetch });
      if (!deps.fetch) resolvers.set(resolverKey, resolver);
    }

    let valid: boolean;
    try {
      valid = await verifyEbaySignature({
        header: c.req.header(EBAY_SIGNATURE_HEADER),
        rawBody,
        getPublicKey: (kid) => resolver.getPublicKey(kid),
      });
    } catch (err) {
      // Key lookup failed (eBay or our app token): not the sender's fault, so ask for a retry.
      console.error('[marketplace] eBay notification key lookup failed', err);
      return c.json({ error: 'signature check unavailable' }, 503);
    }
    if (!valid) return c.json({ error: 'invalid signature' }, 412);

    const body = JSON.parse(rawBody) as EbayNotification;
    const topic = body.metadata?.topic ?? 'unknown';
    const notificationId = body.notification?.notificationId;
    if (!notificationId) return c.json({ error: 'notificationId missing' }, 400);

    const db = getDb(c.var.db);
    const eventId = crypto.randomUUID();
    const inserted = await db.run(
      `INSERT OR IGNORE INTO marketplace_webhook_events (id, platform, external_event_id, topic, payload) VALUES (?, 'ebay', ?, ?, ?)`,
      [eventId, notificationId, topic, rawBody],
    );
    if (inserted.changes === 0) return c.body(null, 204); // redelivery of one we already have

    let error: string | null = null;
    if (EBAY_ORDER_TOPICS.has(topic)) {
      const result = await enqueueOrderPulls(db, c.env.MARKETPLACE_SYNC_QUEUE, { platform: 'ebay' });
      // Still 204: the event is stored, and the cron pulls orders anyway. A 5xx
      // here would only make eBay retry and, after 24h, mark the endpoint down.
      if (result.errors.length) error = result.errors.map((e) => `${e.channelId}: ${e.error}`).join('; ');
    } else if (topic === 'MARKETPLACE_ACCOUNT_DELETION') {
      // Required for production keys. Marketplace orders store the buyer's
      // email/address but not their eBay username or userId, so there is
      // nothing keyed on this user to erase; the event is kept as the record.
      console.log('[marketplace] eBay account deletion notice recorded', notificationId);
    }

    await db.run(`UPDATE marketplace_webhook_events SET processed_at = datetime('now'), error = ? WHERE id = ?`, [error, eventId]);
    return c.body(null, 204);
  });

  for (const platform of ['etsy', 'amazon']) {
    app.post(`/${platform}`, (c) =>
      c.json({ error: `${platform} webhooks are not supported; orders are pulled on a schedule` }, 501),
    );
  }

  return app;
}
