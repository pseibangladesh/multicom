// apps/merchant/src/routes/payment-methods.ts
//
// GET /v1/payment-methods: which gateways the storefront may offer at
// checkout. Public and secret-free: only on/off flags and the Stripe
// publishable key (which is public by design).
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import type { HonoEnv } from '../types';
import { SSLCOMMERZ_CONFIG_KEY, getStripeSettings, readConfigJson } from '../lib/payment-config';

export const publicPaymentMethods = new OpenAPIHono<HonoEnv>();

const PaymentMethods = z.object({
  stripe: z.object({ enabled: z.boolean(), publishable_key: z.string().nullable() }),
  sslcommerz: z.object({ enabled: z.boolean() }),
});

const route = createRoute({
  method: 'get',
  path: '/',
  tags: ['Checkout'],
  summary: 'List enabled payment methods',
  description: 'Gateways the store has switched on and configured under Admin → Payment Gateways.',
  responses: {
    200: { content: { 'application/json': { schema: PaymentMethods } }, description: 'Enabled payment methods' },
  },
});

publicPaymentMethods.openapi(route, async (c) => {
  const db = getDb(c.var.db);
  const stripe = await getStripeSettings(db, c.env);
  const ssl = await readConfigJson(db, SSLCOMMERZ_CONFIG_KEY);
  const sslEnabled = ssl?.enabled === true && !!ssl.store_id && !!ssl.store_password;

  return c.json(
    {
      stripe: { enabled: stripe.enabled, publishable_key: stripe.enabled ? stripe.publishableKey : null },
      sslcommerz: { enabled: sslEnabled },
    },
    200
  );
});
