/**
 * Marketplace sync jobs: queueing (producer side) and execution (consumer side).
 *
 * A job is one row in marketplace_sync_jobs (the source of truth the admin UI
 * reads) plus messages on MARKETPLACE_SYNC_QUEUE that carry only its id. Large
 * pushes run in pages: each message handles PAGE_SIZE variants and sends a
 * continuation message with a cursor. That keeps every queue invocation well
 * under the Workers subrequest limit, because one Etsy listing alone costs
 * several API calls.
 *
 *   push_products   upsert every active physical variant; record the mapping
 *   push_inventory  set the quantity of every mapped variant
 *   pull_orders     import orders (same code path as the manual import route)
 *   sync_all        push_products pages, then pull_orders
 */
import { uuid } from '../../types';
import type { Database } from './auth-manager';
import type { ChannelRow } from './channel';
import { updateChannelConfig } from './channel';
import { importOrders, type OrderImportResult } from './order-import';
import type { IMarketplaceClient, MarketProduct, SyncJobType } from './types';

export const SYNC_JOB_TYPES = ['push_products', 'push_inventory', 'pull_orders', 'sync_all'] as const satisfies readonly SyncJobType[];

/** Variants handled per queue message. */
export const PAGE_SIZE = 20;
/** Retries before a job is marked failed. Keep in step with max_retries in wrangler.jsonc. */
export const MAX_ATTEMPTS = 5;
/** An unfinished job older than this no longer blocks a new one (its worker died). */
export const STALE_JOB_MINUTES = 60;

export interface MarketplaceSyncMessage {
  jobId: string;
  /** Present on continuation messages: resume after this variant id. */
  cursor?: string;
  /** sync_all only: which half is running. */
  phase?: 'products' | 'orders';
}

/** The parts of a Queue binding the producer uses (easy to fake in tests). */
export interface SyncQueue {
  send(body: MarketplaceSyncMessage, options?: { delaySeconds?: number }): Promise<unknown>;
}

export class SyncQueueError extends Error {
  constructor(
    message: string,
    readonly code: 'queue_not_configured' | 'job_already_running' | 'enqueue_failed',
    readonly existingJobId?: string,
  ) {
    super(message);
    this.name = 'SyncQueueError';
  }
}

// ─── Producer ────────────────────────────────────────────────────────────────

/**
 * Records a pending job and sends it to the queue. Refuses while a job of the
 * same type is still pending/in progress for the channel (double clicks, a
 * second admin), unless that job looks dead.
 */
export async function enqueueSyncJob(
  db: Database,
  queue: SyncQueue | undefined,
  channelId: string,
  jobType: SyncJobType,
): Promise<{ jobId: string }> {
  if (!queue) {
    throw new SyncQueueError('MARKETPLACE_SYNC_QUEUE is not bound; see docs/production-checklist.md', 'queue_not_configured');
  }

  const [running] = await db.query<{ id: string }>(
    `SELECT id FROM marketplace_sync_jobs
     WHERE channel_id = ? AND job_type = ? AND status IN ('pending', 'in_progress')
       AND updated_at > datetime('now', ?)
     ORDER BY created_at DESC LIMIT 1`,
    [channelId, jobType, `-${STALE_JOB_MINUTES} minutes`],
  );
  if (running) {
    throw new SyncQueueError('A job of this type is already queued or running for this channel', 'job_already_running', running.id);
  }

  const jobId = uuid();
  await db.run(
    `INSERT INTO marketplace_sync_jobs (id, channel_id, job_type, status, payload) VALUES (?, ?, ?, 'pending', '{}')`,
    [jobId, channelId, jobType],
  );
  try {
    await queue.send({ jobId });
  } catch (err) {
    const message = `Could not enqueue: ${err instanceof Error ? err.message : String(err)}`;
    await db.run(`UPDATE marketplace_sync_jobs SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ?`, [
      message,
      jobId,
    ]);
    throw new SyncQueueError(message, 'enqueue_failed');
  }
  return { jobId };
}

// ─── Order import (shared with the manual route) ─────────────────────────────

const OVERLAP_MS = 60 * 60 * 1000;
const FIRST_IMPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Without `since`, resume from the last successful import minus 1h of overlap (import is idempotent), or 30 days back. */
export function orderImportWindowStart(channel: ChannelRow, now: Date, since?: Date): Date {
  if (since) return since;
  if (channel.config.last_order_import_at) {
    return new Date(new Date(channel.config.last_order_import_at).getTime() - OVERLAP_MS);
  }
  return new Date(now.getTime() - FIRST_IMPORT_WINDOW_MS);
}

export async function runOrderImport(
  db: Database,
  client: Pick<IMarketplaceClient, 'listOrders'>,
  channel: ChannelRow,
  opts: { since?: Date; limit?: number; now?: Date } = {},
): Promise<{ from: Date; result: OrderImportResult }> {
  const startedAt = opts.now ?? new Date();
  const from = orderImportWindowStart(channel, startedAt, opts.since);
  const result = await importOrders(db, client, channel.id, { from, limit: opts.limit });
  // Failed orders were not recorded, so keep the window where it was and they
  // are picked up again next run. A `limit` may also cut the window short.
  if (result.failed.length === 0 && opts.limit === undefined) {
    await updateChannelConfig(db, channel.id, { last_order_import_at: startedAt.toISOString() });
  }
  return { from, result };
}

export function orderImportSummary(from: Date, result: OrderImportResult) {
  return {
    from: from.toISOString(),
    fetched: result.fetched,
    imported: result.imported.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    shortfalls: result.shortfalls.length,
  };
}

// ─── Catalog → MarketProduct ─────────────────────────────────────────────────

/** Titles/descriptions may be plain text or per-locale JSON ({"en-US": "...", "fr-FR": "..."}). */
export function plainText(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const pick = ['en-US', 'en', ...Object.keys(parsed)].map((k) => parsed[k]).find((v) => typeof v === 'string' && v.trim());
    return typeof pick === 'string' ? pick : value;
  } catch {
    return value;
  }
}

interface VariantRow {
  id: string;
  sku: string;
  variant_title: string;
  price_cents: number;
  currency: string;
  weight_g: number;
  requires_shipping: number;
  variant_image: string | null;
  variant_status: string;
  product_title: string;
  description: string | null;
  product_image: string | null;
  product_status: string;
  sibling_count: number;
  available: number;
}

const DEFAULT_VARIANT_TITLES = new Set(['', 'default', 'default title']);

export function variantToMarketProduct(row: VariantRow): MarketProduct {
  const productTitle = plainText(row.product_title);
  const variantTitle = plainText(row.variant_title);
  const title =
    row.sibling_count > 1 && !DEFAULT_VARIANT_TITLES.has(variantTitle.trim().toLowerCase()) && variantTitle !== productTitle
      ? `${productTitle} - ${variantTitle}`
      : productTitle;
  return {
    id: row.id,
    sku: row.sku,
    title,
    description: plainText(row.description),
    priceCents: row.price_cents,
    currency: row.currency,
    imageUrl: row.variant_image || row.product_image || null,
    quantity: Math.max(0, row.available),
    weightG: row.weight_g,
    requiresShipping: row.requires_shipping !== 0,
    status: row.product_status === 'active' && row.variant_status === 'active' ? 'active' : 'draft',
  };
}

const VARIANT_SELECT = `
  SELECT v.id, v.sku, v.title AS variant_title, v.price_cents, v.currency, v.weight_g, v.requires_shipping,
         v.image_url AS variant_image, v.status AS variant_status,
         p.title AS product_title, p.description, p.image_url AS product_image, p.status AS product_status,
         (SELECT COUNT(*) FROM variants s WHERE s.product_id = p.id) AS sibling_count,
         COALESCE(i.on_hand - i.reserved, 0) AS available
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory i ON i.sku = v.sku`;

/** Physical variants of active products, in id order after `cursor`. */
async function pushableVariants(db: Database, cursor: string | undefined, limit: number): Promise<VariantRow[]> {
  return db.query<VariantRow>(
    `${VARIANT_SELECT}
     WHERE p.status = 'active' AND v.status = 'active' AND COALESCE(v.variant_type, 'physical') = 'physical' AND v.id > ?
     ORDER BY v.id LIMIT ?`,
    [cursor ?? '', limit],
  );
}

/** Variants this channel already lists, in id order after `cursor`. */
async function mappedVariants(db: Database, channelId: string, cursor: string | undefined, limit: number): Promise<VariantRow[]> {
  return db.query<VariantRow>(
    `${VARIANT_SELECT}
     WHERE v.id IN (SELECT variant_id FROM marketplace_product_mappings WHERE channel_id = ? AND status = 'active')
       AND v.id > ?
     ORDER BY v.id LIMIT ?`,
    [channelId, cursor ?? '', limit],
  );
}

async function recordMapping(db: Database, channelId: string, variantId: string, sku: string, externalId: string, status: 'active' | 'error') {
  const [existing] = await db.query<{ id: string }>(
    `SELECT id FROM marketplace_product_mappings WHERE channel_id = ? AND variant_id = ?`,
    [channelId, variantId],
  );
  if (existing) {
    await db.run(
      `UPDATE marketplace_product_mappings SET external_listing_id = ?, external_sku = ?, status = ?, last_sync_at = datetime('now') WHERE id = ?`,
      [externalId, sku, status, existing.id],
    );
  } else {
    await db.run(
      `INSERT INTO marketplace_product_mappings (id, channel_id, variant_id, external_listing_id, external_sku, status, last_sync_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [uuid(), channelId, variantId, externalId, sku, status],
    );
  }
}

// ─── Consumer ────────────────────────────────────────────────────────────────

export interface PageProgress {
  processed: number;
  succeeded: number;
  failed: number;
  /** First few per-item errors, for the admin. */
  errors: Array<{ sku: string; error: string }>;
}

const MAX_RECORDED_ERRORS = 20;

function emptyProgress(): PageProgress {
  return { processed: 0, succeeded: 0, failed: 0, errors: [] };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worth retrying: HTTP 429 and 5xx (except 501 Not Implemented), and network
 * failures (fetch rejects with a TypeError; timeouts are TimeoutError /
 * AbortError). Anything else (4xx, config errors such as missing listing
 * defaults) fails the same way every time.
 */
export function isRetryable(err: unknown): boolean {
  const e = err as { status?: unknown; statusCode?: unknown; name?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (status !== undefined) return status === 429 || (status >= 500 && status !== 501);
  return err instanceof TypeError || e?.name === 'TimeoutError' || e?.name === 'AbortError';
}

interface JobRow {
  id: string;
  channel_id: string;
  job_type: SyncJobType;
  status: string;
  payload: string | null;
}

export type SyncOutcome =
  /** Done (or nothing to do): ack the message. */
  | { kind: 'ack' }
  /** More pages: ack this message and send `next`. */
  | { kind: 'continue'; next: MarketplaceSyncMessage }
  /** Transient failure: let the queue redeliver this message after a delay. */
  | { kind: 'retry'; delaySeconds: number };

export interface SyncDeps {
  db: Database;
  loadChannel: (channelId: string) => Promise<ChannelRow>;
  clientFor: (channel: ChannelRow) => IMarketplaceClient;
  pageSize?: number;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function mergeProgress(prev: unknown, page: PageProgress): PageProgress {
  const p = (prev && typeof prev === 'object' ? prev : {}) as Partial<PageProgress>;
  return {
    processed: (p.processed ?? 0) + page.processed,
    succeeded: (p.succeeded ?? 0) + page.succeeded,
    failed: (p.failed ?? 0) + page.failed,
    errors: [...(p.errors ?? []), ...page.errors].slice(0, MAX_RECORDED_ERRORS),
  };
}

/**
 * Runs one queue message. `attempts` is the queue's delivery count (1 on the
 * first try). Never throws for job-level failures: they are written to the job
 * row and turned into an outcome.
 */
export async function processSyncMessage(deps: SyncDeps, msg: MarketplaceSyncMessage, attempts: number): Promise<SyncOutcome> {
  const { db } = deps;
  const pageSize = deps.pageSize ?? PAGE_SIZE;
  const [job] = await db.query<JobRow>(`SELECT id, channel_id, job_type, status, payload FROM marketplace_sync_jobs WHERE id = ?`, [msg.jobId]);
  // Unknown job, or a redelivery of one that already finished.
  if (!job || job.status === 'completed' || job.status === 'failed') return { kind: 'ack' };

  const payload = parsePayload(job.payload);
  const save = (status: 'in_progress' | 'pending' | 'completed' | 'failed', error: string | null = null, countAttempt = false) =>
    db.run(
      `UPDATE marketplace_sync_jobs SET status = ?, payload = ?, error_message = ?, attempts = attempts + ?, updated_at = datetime('now') WHERE id = ?`,
      [status, JSON.stringify(payload), error, countAttempt ? 1 : 0, job.id],
    );
  const fail = async (message: string): Promise<SyncOutcome> => {
    await save('failed', message);
    return { kind: 'ack' };
  };

  if (!(SYNC_JOB_TYPES as readonly string[]).includes(job.job_type)) return fail(`Unknown job type ${job.job_type}`);

  await save('in_progress', null, true);

  try {
    const channel = await deps.loadChannel(job.channel_id);
    if (channel.status !== 'active') return fail(`Channel is ${channel.status}`);
    const client = deps.clientFor(channel);

    const phase = job.job_type === 'sync_all' ? (msg.phase ?? 'products') : undefined;

    if (job.job_type === 'pull_orders' || phase === 'orders') {
      const { from, result } = await runOrderImport(db, client, channel);
      payload.orders = orderImportSummary(from, result);
      await save('completed');
      return { kind: 'ack' };
    }

    // push_products / push_inventory / sync_all (products phase): one page.
    const isInventory = job.job_type === 'push_inventory';
    const rows = isInventory
      ? await mappedVariants(db, channel.id, msg.cursor, pageSize)
      : await pushableVariants(db, msg.cursor, pageSize);

    const page = emptyProgress();
    for (const row of rows) {
      page.processed++;
      const product = variantToMarketProduct(row);
      try {
        if (isInventory) {
          await client.updateInventory(product.sku, product.quantity);
          await db.run(
            `UPDATE marketplace_product_mappings SET last_sync_at = datetime('now') WHERE channel_id = ? AND variant_id = ?`,
            [channel.id, row.id],
          );
        } else {
          const externalId = await client.upsertProduct(product);
          await recordMapping(db, channel.id, row.id, row.sku, externalId, 'active');
        }
        page.succeeded++;
      } catch (err) {
        // Rate limits and outages fail the whole page so it is retried; a bad
        // item (validation error) is recorded and the push moves on.
        if (isRetryable(err)) throw err;
        page.failed++;
        if (page.errors.length < MAX_RECORDED_ERRORS) page.errors.push({ sku: row.sku, error: errorText(err) });
      }
    }

    const key = isInventory ? 'inventory' : 'products';
    payload[key] = mergeProgress(payload[key], page);

    if (rows.length === pageSize) {
      payload.cursor = rows[rows.length - 1].id;
      await save('in_progress');
      return { kind: 'continue', next: { jobId: job.id, cursor: rows[rows.length - 1].id, ...(phase && { phase }) } };
    }
    delete payload.cursor;

    if (phase === 'products') {
      await save('in_progress');
      return { kind: 'continue', next: { jobId: job.id, phase: 'orders' } };
    }

    const total = payload[key] as PageProgress;
    if (total.processed > 0 && total.succeeded === 0) {
      return fail(`All ${total.failed} item(s) failed; first error: ${total.errors[0]?.error ?? 'unknown'}`);
    }
    await save('completed');
    return { kind: 'ack' };
  } catch (err) {
    const message = errorText(err);
    if (isRetryable(err) && attempts < MAX_ATTEMPTS) {
      await save('pending', `Attempt ${attempts} failed, retrying: ${message}`);
      // 30s, 60s, 120s, 240s…
      return { kind: 'retry', delaySeconds: Math.min(30 * 2 ** (attempts - 1), 900) };
    }
    return fail(message);
  }
}
