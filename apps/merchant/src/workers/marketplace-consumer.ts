/**
 * Queue consumer for MARKETPLACE_SYNC_QUEUE.
 *
 * Runs in the same Worker as the API (src/index.ts exports it as the `queue`
 * handler), so it shares the MerchantDO binding, secrets and code. The job
 * logic lives in lib/marketplace/sync-jobs.ts; this file only maps outcomes to
 * queue acknowledgements.
 *
 * Messages are processed one at a time: jobs for the same channel share the
 * marketplace's rate limit, and wrangler.jsonc sets max_concurrency to 1 for
 * the same reason.
 */
import { getDb } from '../db';
import type { DOStub, Env } from '../types';
import { clientForChannel, loadChannel } from '../lib/marketplace/channel';
import { processSyncMessage, type MarketplaceSyncMessage, type SyncDeps } from '../lib/marketplace/sync-jobs';

export function isSyncMessage(body: unknown): body is MarketplaceSyncMessage {
  return !!body && typeof body === 'object' && typeof (body as { jobId?: unknown }).jobId === 'string';
}

export function syncDepsFromEnv(env: Env): SyncDeps {
  const db = getDb(env.MERCHANT.get(env.MERCHANT.idFromName('default')) as unknown as DOStub);
  return {
    db,
    loadChannel: (id) => loadChannel(db, id),
    clientFor: (channel) => clientForChannel(db, env, channel),
  };
}

export async function handleMarketplaceQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  deps: SyncDeps = syncDepsFromEnv(env),
): Promise<void> {
  for (const message of batch.messages) {
    if (!isSyncMessage(message.body)) {
      console.error('marketplace-sync: dropping malformed message', message.id);
      message.ack();
      continue;
    }
    try {
      const outcome = await processSyncMessage(deps, message.body, message.attempts);
      if (outcome.kind === 'retry') {
        message.retry({ delaySeconds: outcome.delaySeconds });
        continue;
      }
      if (outcome.kind === 'continue') {
        if (!env.MARKETPLACE_SYNC_QUEUE) throw new Error('MARKETPLACE_SYNC_QUEUE is not bound');
        await env.MARKETPLACE_SYNC_QUEUE.send(outcome.next);
      }
      message.ack();
    } catch (err) {
      // Only infrastructure errors reach here (the DO or the queue itself);
      // job errors are handled inside processSyncMessage. Let the queue retry,
      // and the dead letter queue catch it after max_retries.
      console.error('marketplace-sync: infrastructure error', message.body.jobId, err);
      message.retry({ delaySeconds: 60 });
    }
  }
}
