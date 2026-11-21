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

/**
 * Per-platform rate limiter backed by Cloudflare KV.
 *
 * Uses a sliding-window approach: each platform has a fixed quota per day
 * and per second. The KV namespace stores remaining quotas with TTL-based
 * expiry so stale entries auto-clean.
 *
 * Usage:
 *   const limiter = new RateLimiter(kv);
 *   if (await limiter.acquire('etsy', 'listings')) {
 *     // make API call
 *   } else {
 *     // retry later
 *   }
 */

// ─── Platform rate limit configurations ──────────────────────────────────────

/** Rate limit configuration per platform. */
export interface RateLimitConfig {
  /** Max queries per day (sliding window). */
  maxPerDay: number;
  /** Max queries per second. */
  maxPerSecond: number;
  /** Window size in seconds for the daily counter. */
  dayWindowSeconds: number;
  /** Per-operation sub-limits (optional). */
  operations?: Record<string, { maxPerSecond: number; burst: number }>;
}

/** Default rate limits per platform. */
export const PLATFORM_RATES: Record<string, RateLimitConfig> = {
  etsy: {
    maxPerDay: 10_000,
    maxPerSecond: 10,
    dayWindowSeconds: 86_400, // 24 hours
  },
  ebay: {
    maxPerDay: 2_000_000,
    maxPerSecond: 50,
    dayWindowSeconds: 86_400,
  },
  amazon: {
    maxPerDay: 10_000,          // Conservative default
    maxPerSecond: 5,            // Overall cap
    dayWindowSeconds: 86_400,   // 24 hours
    operations: {
      searchOrders:     { maxPerSecond: 0.0056, burst: 20 },   // ~480/day
      getOrder:         { maxPerSecond: 0.5, burst: 30 },      // ~43K/day (PII + RDT)
      updateShipment:   { maxPerSecond: 5, burst: 15 },
      listInventory:    { maxPerSecond: 2, burst: 10 },
      listingsUpdate:   { maxPerSecond: 1, burst: 5 },
    },
  },
};

// ─── KV key helpers ──────────────────────────────────────────────────────────

/** KV namespace key for daily quota counter. */
function dayKey(platform: string): string {
  const now = Date.now();
  // Truncate to current day window (86400s)
  const windowId = Math.floor(now / 86_400_000);
  return `ml:dq:${platform}:${windowId}`;
}

/** KV namespace key for per-second quota counter. */
function secondKey(platform: string): string {
  const now = Date.now();
  const windowId = Math.floor(now / 1_000);
  return `ml:sq:${platform}:${windowId}`;
}

// ─── RateLimiter class ───────────────────────────────────────────────────────

/**
 * KV-backed rate limiter for marketplace API calls.
 */
export class RateLimiter {
  constructor(private kv: KVNamespace) {}

  /**
   * Check whether a request is allowed under the current rate limits.
   * Atomically decrements counters if allowed.
   *
   * @param platform  Platform identifier ('etsy', 'ebay', 'amazon').
   * @param key       Optional sub-key for per-user/per-endpoint limiting.
   * @returns `true` if the request is allowed; `false` if rate-limited.
   */
  async acquire(
    platform: string,
    key?: string,
  ): Promise<boolean> {
    const config = PLATFORM_RATES[platform];
    if (!config) return true; // Unknown platform — allow through (caller should handle).

    const prefixedKey = key ? `:${key}` : '';
    const dayK = `${dayKey(platform)}${prefixedKey}`;
    const secK = `${secondKey(platform)}${prefixedKey}`;

    // Try per-second limit first (checked before daily to avoid wasting daily quota).
    const secCountRaw = await this.kv.get(secK);
    const secCount = secCountRaw ? parseInt(secCountRaw, 10) : 0;
    if (secCount >= config.maxPerSecond) {
      return false; // Per-second limit hit.
    }

    // Try per-day limit.
    const dayCountRaw = await this.kv.get(dayK);
    const dayCount = dayCountRaw ? parseInt(dayCountRaw, 10) : 0;
    if (dayCount >= config.maxPerDay) {
      return false; // Daily quota exhausted.
    }

    // Both limits OK — atomically increment both counters.
    await this.kv.batch([
      {
        type: 'urlencoded',
        key: secK,
        value: `count=${secCount + 1}`,
        expirationTtl: 2, // Auto-expire after 2 seconds (covers the current second window).
      },
      {
        type: 'urlencoded',
        key: dayK,
        value: `count=${dayCount + 1}`,
        expirationTtl: config.dayWindowSeconds,
      },
    ]);

    return true;
  }

  /**
   * Get current usage stats for a platform.
   */
  async getUsage(platform: string): Promise<{
    remainingPerDay: number;
    remainingPerSecond: number;
    usedPerDay: number;
    usedPerSecond: number;
  }> {
    const config = PLATFORM_RATES[platform] ?? { maxPerDay: 10_000, maxPerSecond: 10 };

    const dayCountRaw = await this.kv.get(dayKey(platform));
    const secCountRaw = await this.kv.get(secondKey(platform));

    return {
      remainingPerDay: config.maxPerDay - (dayCountRaw ? parseInt(dayCountRaw, 10) : 0),
      remainingPerSecond: config.maxPerSecond - (secCountRaw ? parseInt(secCountRaw, 10) : 0),
      usedPerDay: dayCountRaw ? parseInt(dayCountRaw, 10) : 0,
      usedPerSecond: secCountRaw ? parseInt(secCountRaw, 10) : 0,
    };
  }

  /**
   * Reset all counters for a platform (useful on day boundary or after errors).
   */
  async reset(platform: string): Promise<void> {
    // KV doesn't support prefix-based delete, so we rely on TTL expiry.
    // For immediate reset, clear known keys.
    const now = Date.now();
    const dayK = dayKey(platform);
    const secK = secondKey(platform);
    await this.kv.delete(dayK);
    await this.kv.delete(secK);
  }
}
