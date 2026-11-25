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

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { allowedOrigins } from './lib/session';
import { swaggerUI } from '@hono/swagger-ui';
import { adminSetup } from './routes/setup';
import { adminCatalog } from './routes/catalog';
import { adminInventory } from './routes/inventory';
import { adminCheckout } from './routes/checkout';
import { adminOrders, publicOrders } from './routes/orders';
import { adminCustomers } from './routes/customers';
import { webhooks } from './routes/webhooks';
import { adminWebhooksRoutes } from './routes/webhooks-outbound';
import { publicImages } from './routes/images';
import { adminDiscounts } from './routes/discounts';
import { oauth } from './routes/oauth';
import { ucp } from './routes/ucp';
import { adminMe } from './routes/me';
import { adminUserPreferencesRouter } from './routes/user-preferences';
import { adminSavedCartsRouter } from './routes/saved-carts';
import { publicCategories, adminCategories, adminCategoryList } from './routes/categories';
import { adminAnalytics } from './routes/analytics';
import { reviews, adminReviews } from './routes/reviews';
import { adminRegions } from './routes/regions';
import { adminOrderEmailSettings } from './routes/order-email-settings';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { kvCacheMiddleware, kvInvalidateMiddleware } from './middleware/kv-cache';
import { adminAi } from './routes/ai';
import { adminTaxRates } from './routes/tax-rates';
import { ApiError, type Env, type DOStub } from './types';
import { MerchantDO } from './do';
import { adminMails } from './routes/mails';
import { sitemapRouter } from './routes/sitemap';
import { adminDigitalAssetVariantRouter, adminDigitalAssetsRouter } from './routes/digital-assets';
import { customerOrderDownloads, publicDownloads } from './routes/downloads';
import { customerAiTokensRouter, proxyAiTokensRouter, adminAiTokensRouter } from './routes/ai-tokens';
import { sslcommerzCheckoutApp, sslcommerzIpnApp } from './routes/sslcommerz-ipn';
import { adminSettings } from './routes/admin-settings';
import { publicBanners, adminBanners } from './routes/banners';
import { publicHome, adminHomeSections } from './routes/home-sections';
import { adminApiKeys } from './routes/api-keys';
import { publicStorefrontSettings, adminStorefrontSettings } from './routes/storefront-settings';
import { publicSiteContent, adminSiteContent } from './routes/site-content';
import { publicPaymentMethods } from './routes/payment-methods';
import { marketplaceRoutes } from './routes/marketplace';
import { adminMarketplaceChannelRoutes } from './routes/marketplace/channels';
import { handleMarketplaceQueue } from './workers/marketplace-consumer';
import { enqueueOrderPulls } from './lib/marketplace/sync-jobs';
import { getDb } from './db';

// ... inside the app setup ...



export { MerchantDO };

type Variables = {
  db: DOStub;
};

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
});

// CORS is an allowlist: only STORE_URL (or the comma-separated CORS_ORIGIN
// override, e.g. storefront + a separate admin host) gets an
// Access-Control-Allow-Origin header, with credentials so the Better Auth
// session cookie is sent. Any other browser origin gets no CORS headers and
// cannot read responses. There is no '*' fallback; if neither variable is set,
// no browser origin is allowed (fail closed). Server-to-server callers with
// pk_/sk_ keys are unaffected because CORS only applies to browsers.
app.use('*', (c, next) => {
  const allowed = allowedOrigins(c.env);
  return cors({
    origin: (origin) => (origin && allowed.includes(origin) ? origin : null),
    credentials: true,
    maxAge: 600,
  })(c, next);
});

app.use('*', async (c, next) => {
  const id = c.env.MERCHANT.idFromName('default');
  const stub = c.env.MERCHANT.get(id);
  c.set('db', stub as unknown as DOStub);
  await next();
});

// KV cache & invalidation: must be registered on the parent app with app.use()
// BEFORE app.route() so they execute first in Hono's middleware chain.
//
// kvCacheMiddleware caches:
//   • Unauthenticated GETs (public categories, reviews)
//   • GETs with a public key (Bearer pk_...) — same response for all storefront
//     visitors; products and product pages are the highest-traffic endpoints.
// Admin tokens (sk_ / JWT) always bypass the cache.
//
// kvInvalidateMiddleware purges by prefix on successful mutations, covering
// both the list and all paginated/filtered/detail variants of each namespace.
app.use('/v1/categories', kvCacheMiddleware);
app.use('/v1/categories/*', kvCacheMiddleware);
app.use('/v1/products', kvCacheMiddleware);
app.use('/v1/products/*', kvCacheMiddleware);
app.use('/openapi.json', kvCacheMiddleware);
app.use('/openapi/*', kvCacheMiddleware);
app.use('/.well-known/ucp', kvCacheMiddleware);
app.use('/ucp/v1/products', kvCacheMiddleware);
app.use('/ucp/v1/products/*', kvCacheMiddleware);
app.use('/ucp/v1/categories', kvCacheMiddleware);
app.use('/v1/storefront/home', kvCacheMiddleware);
app.use('/v1/categories', kvInvalidateMiddleware);
app.use('/v1/categories/*', kvInvalidateMiddleware);
app.use('/v1/products', kvInvalidateMiddleware);
app.use('/v1/products/*', kvInvalidateMiddleware);
app.use('/v1/admin/home-sections', kvInvalidateMiddleware);
app.use('/v1/admin/home-sections/*', kvInvalidateMiddleware);
// demo-reset deletes products/categories outside those prefixes
app.use('/v1/setup/demo-reset', kvInvalidateMiddleware);

// Mount public routes BEFORE authentication middleware
app.route('/', sitemapRouter);         // /sitemap.xml — no auth
app.route('/v1/orders', publicOrders);
app.route('/v1/categories', publicCategories);
app.route('/v1/payment-methods', publicPaymentMethods); // storefront: which gateways are on
app.route('/v1/banners', publicBanners);                 // storefront: home-page banners
app.route('/v1/storefront', publicStorefrontSettings);    // storefront: enabled languages
app.route('/v1/storefront', publicHome);                  // storefront: home page sections
app.route('/v1/storefront', publicSiteContent);            // storefront: footer social links, page edits
// Admin settings
app.route('/v1/admin', adminSettings);
// Mounted here, before the '/v1' routers whose use('*', customerAuthMiddleware)
// would otherwise reject admin API keys for every later /v1 route.
app.route('/v1/admin/settings', adminStorefrontSettings); // languages, UCP switch, AI status
app.route('/v1/admin/settings', adminSiteContent);        // social links, page content
app.route('/v1/admin/banners', adminBanners);
app.route('/v1/admin/home-sections', adminHomeSections); // page builder
app.route('/v1/admin/categories', adminCategoryList); // all categories incl. showcase-only (public lists hide them)
app.route('/v1/admin/api-keys', adminApiKeys);

// SSLCommerz Checkout (under carts)
app.route('/v1/carts', sslcommerzCheckoutApp);

// SSLCommerz IPN (public webhook)
app.route('/v1/webhooks/sslcommerz', sslcommerzIpnApp);
app.use('/v1/*', rateLimitMiddleware());

app.onError((err, c) => {
  console.error(err);

  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details && { details: err.details }),
        },
      },
      err.statusCode as any
    );
  }

  // Extract detailed error message for database and other errors
  const errorMessage = err instanceof Error ? err.message : String(err);
  const message = `Internal server error${errorMessage ? ': ' + errorMessage : ''}`;

  return c.json({ error: { code: 'internal', message } }, 500);
});

app.get('/', (c) => c.json({ name: 'bengal-exchange', version: '0.1.0', ok: true }));

app.route('/v1/setup', adminSetup);
app.route('/v1/ai', adminAi);
// Mount reviews BEFORE catalog — catalog has app.use('*', authMiddleware) which
// would otherwise intercept /v1/products/:productId/reviews/guest (a public route)
app.route('/v1/products/:productId/reviews', reviews);
app.route('/v1/products', adminCatalog);
app.route('/v1/inventory', adminInventory);
app.route('/v1/carts', adminCheckout);
app.route('/v1/orders', adminOrders);
app.route('/v1/categories', adminCategories);
app.route('/v1/analytics', adminAnalytics);
app.route('/v1/reviews', adminReviews);
app.route('/v1/customers', adminCustomers);
app.route('/v1/webhooks', webhooks);
app.route('/v1/webhooks', adminWebhooksRoutes);
app.route('/v1/images', publicImages);
app.route('/v1/discounts', adminDiscounts);
app.route('/v1/regions', adminRegions);
app.route('/v1/tax-rates', adminTaxRates);
app.route('/v1/mails', adminMails);
app.route('/v1/admin/order-email-settings', adminOrderEmailSettings);
app.route('/v1/me', adminMe);
app.route('/v1/me/ai-tokens', customerAiTokensRouter);
app.route('/v1', adminUserPreferencesRouter);
app.route('/v1', adminSavedCartsRouter);
app.route('/v1/orders', customerOrderDownloads);
app.route('/v1/downloads', publicDownloads);
app.route('/v1/products', adminDigitalAssetVariantRouter);
app.route('/v1/admin/digital-assets', adminDigitalAssetsRouter);
app.route('/v1/ai-tokens/proxy', proxyAiTokensRouter);
app.route('/v1/admin/ai-tokens', adminAiTokensRouter);
app.route('/v1/admin/settings', adminSettings);
// Marketplace integrations (OAuth connect, webhooks, sync)
app.route('/v1/marketplace', marketplaceRoutes());
app.route('/v1/admin/marketplace', adminMarketplaceChannelRoutes()); // channel list + config (admin UI)
app.route('/oauth', oauth);
app.route('', oauth);
app.route('/', ucp);
// Better Auth routes (sign-in, sign-up, sign-out, session). Better Auth runs
// inside MerchantDO because the DO's SQLite storage is only reachable there.
app.all('/api/auth/*', async (c) => {
  const stub = c.env.MERCHANT.get(c.env.MERCHANT.idFromName('default'));
  return stub.fetch(c.req.raw);
});

app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Bengali Exchange API',
    version: '1.0.0',
    description: 'The open-source commerce backend for Cloudflare + Stripe + Better Auth',
  },
  servers: [{ url: '/' }],
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));

export default {
  fetch: app.fetch,
  // Consumer for MARKETPLACE_SYNC_QUEUE (see wrangler.jsonc "queues.consumers").
  async queue(batch: MessageBatch<unknown>, env: Env) {
    await handleMarketplaceQueue(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const id = env.MERCHANT.idFromName('default');
    const stub = env.MERCHANT.get(id);
    const cleaned = await (stub as unknown as { cleanupExpiredCarts: () => Promise<number> }).cleanupExpiredCarts();
    console.log(`Cron: cleaned ${cleaned} expired carts`);

    // Order pulls for every connected channel. This is the only trigger for
    // Etsy and the safety net for eBay (webhooks can be missed). Channels with
    // a pull already queued or running are skipped.
    if (env.MARKETPLACE_SYNC_QUEUE) {
      const pulls = await enqueueOrderPulls(getDb(stub as unknown as DOStub), env.MARKETPLACE_SYNC_QUEUE);
      console.log(`Cron: queued order pulls for ${pulls.queued.length} channel(s), ${pulls.alreadyRunning.length} already running`);
      for (const e of pulls.errors) console.error(`Cron: order pull for ${e.channelId} not queued: ${e.error}`);
    }
  },
};
