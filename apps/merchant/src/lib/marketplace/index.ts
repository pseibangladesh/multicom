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
 * Marketplace integration module — shared types and interfaces.
 *
 * Platform-specific clients (Etsy, eBay, Amazon) implement the {@link IMarketplaceClient}
 * interface defined here. The admin layer and sync engine interact through this interface,
 * remaining agnostic of the underlying platform.
 */

export type { MarketplacePlatform } from './types';
export type {
  MarketProduct,
  CreateMarketProductBody,
  MarketInventoryItem,
  MarketOrder,
  MarketWebhookEvent,
  SyncJobType,
  SyncJobStatus,
  SyncJob,
  CredentialType,
} from './types';
export type { IMarketplaceClient } from './types';
export type { RateLimitConfig } from './rate-limiter';

export { PLATFORM_RATES } from './rate-limiter';
export type { RateLimiter as RateLimiterClass } from './rate-limiter';
export { CredentialManager, type Database } from './auth-manager';
export { mapProductToMarketplace, mapMarketplaceToProduct, mapMarketplaceToOrder } from './data-mapper';
export { EtsyClient } from './etsy';
export { EbayClient } from './ebay';
export { AmazonClient } from './amazon';
