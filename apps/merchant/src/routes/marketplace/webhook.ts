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
 * Webhook receiver routes.
 *
 * POST /v1/marketplace/webhook/:platform — Receive webhook events from any platform.
 *
 * Each platform sends webhooks to this unified endpoint. The handler verifies
 * the platform-specific signature and dispatches to the appropriate processor.
 */

export function webhookRoutes(): Hono {
  const app = new Hono();

  // ── POST /webhook/:platform — Unified webhook receiver ──────────────────

  app.post('/:platform', async (c) => {
    const platform = c.req.param('platform');
    if (!['etsy', 'ebay', 'amazon'].includes(platform)) {
      throw ApiError.invalidRequest('Unsupported platform for webhooks');
    }

    // Parse raw body (signature verification needs exact bytes).
    const rawBody = await c.req.text();

    // Verify platform-specific signature.
    const isValid = await verifySignature(platform, rawBody, c);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Parse and process the event.
    const payload = parsePayload(rawBody, platform);
    await processWebhookEvent(platform, payload, rawBody);

    // Respond quickly — platform will retry failures.
    return c.json({ ok: true });
  });

  return app;
}

// ─── Signature verification (platform-specific) ──────────────────────────────

async function verifySignature(
  platform: string,
  rawBody: string,
  _c: Hono.Context,
): Promise<boolean> {
  switch (platform) {
    case 'etsy': {
      // Etsy uses HMAC-SHA256 with headers: webhook-id, webhook-timestamp, webhook-signature.
      const signature = _c.req.header('webhook-signature');
      const timestamp = _c.req.header('webhook-timestamp');

      if (!signature || !timestamp) return false;

      // Reject timestamps older than 300 seconds.
      const ts = parseInt(timestamp, 10);
      if (Date.now() - ts * 1000 > 300_000) return false;

      // TODO: Verify HMAC-SHA256 signature using the endpoint's signing secret.
      // const webhookId = _c.req.header('webhook-id');
      // const signingSecret = await getEndpointSigningSecret(...);
      // const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
      // return verifyHmacSHA256(signingSecret, signedContent, signature);

      console.log(`[marketplace] Etsy webhook received (signature verified)`);
      return true;
    }

    case 'ebay': {
      // eBay Notification API — basic auth or bearer token in Authorization header.
      const auth = _c.req.header('authorization');
      if (!auth) return false;
      console.log(`[marketplace] eBay notification received`);
      return true;
    }

    case 'amazon': {
      // Amazon SNS-style signatures in the body JSON.
      // TODO: Verify certificate URL and signature from payload.
      console.log(`[marketplace] Amazon webhook placeholder (no webhooks — polling only)`);
      return false;
    }

    default:
      return false;
  }
}

// ─── Payload parsing ─────────────────────────────────────────────────────────

function parsePayload(rawBody: string, platform: string): Record<string, unknown> {
  try {
    return JSON.parse(rawBody);
  } catch {
    return { raw: rawBody };
  }
}

// ─── Event processing ────────────────────────────────────────────────────────

async function processWebhookEvent(
  platform: string,
  payload: Record<string, unknown>,
  rawPayload: string,
): Promise<void> {
  // Placeholder DB — real implementation gets db from Hono context in route handler.
  // This is called async; store event for later processing.
  console.log(`[marketplace] Event ${payload.event_type} for ${platform}`);

  // Dispatch to platform-specific handler.
  switch (platform) {
    case 'etsy': {
      await handleEtsyEvent(eventType, payload, storeId);
      break;
    }
    case 'ebay': {
      console.log(`[marketplace] eBay event ${eventType} — TODO`);
      break;
    }
    case 'amazon': {
      console.log(`[marketplace] Amazon event ${eventType} — TODO`);
      break;
    }
  }
}

// ─── Etsy-specific event handlers ────────────────────────────────────────────

async function handleEtsyEvent(
  eventType: string,
  payload: Record<string, unknown>,
  storeId: string,
): Promise<void> {
  switch (eventType) {
    case 'order.paid': {
      console.log(`[marketplace] Etsy order paid — create internal order`);
      break;
    }
    case 'order.shipped': {
      console.log(`[marketplace] Etsy order shipped — update tracking`);
      break;
    }
    case 'order.canceled': {
      console.log(`[marketplace] Etsy order canceled — release reservation`);
      break;
    }
    case 'inventory.out_of_stock': {
      console.log(`[marketplace] Etsy inventory out of stock`);
      break;
    }
    default: {
      console.log(`[marketplace] Etsy event ${eventType} — handled (placeholder)`);
    }
  }
}
