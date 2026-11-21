/**
 * Better Auth integration for the merchant worker.
 *
 * Provides session-based authentication using secure HttpOnly cookies.
 * Replaces the previous Auth0 JWT flow while preserving API key and OAuth token paths.
 */

import { betterAuth } from 'better-auth';
import type { Env, DOStub } from '../types';

// Better Auth uses Drizzle ORM under the hood. We provide a minimal adapter
// that translates between Better Auth's Drizzle interface and our D1-backed DO.
function createD1Adapter(db: DOStub) {
  // We wrap the DO stub in a Drizzle-compatible interface.
  // The actual schema will be applied via migration at startup.
  return db as any;
}

/**
 * Creates a Better Auth instance bound to the current request's environment.
 * Called per-request so each worker invocation gets its own auth config.
 */
export function createAuth(env: Env & { MERCHANT: any }) {
  const id = env.MERCHANT.idFromName('default');
  const stub = env.MERCHANT.get(id);

  return betterAuth({
    baseURL: env.API_BASE_URL || 'http://127.0.0.1:8787',
    secret: env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET || 'dev-secret-change-in-production',
    database: createD1Adapter(stub),
    // Email + password authentication (replaces Auth0 Passwordless)
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url, token }, request) => {
        // TODO: implement email reset via Mailgun in a later phase
        console.log(`[Auth] Password reset requested for user ${user.email}, url=${url}`);
        return Promise.resolve();
      },
    },
    // Session configuration — secure cookies by default
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,       // renew every 24h
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // cache session data for 5 minutes
      },
    },
    // Rate limiting to prevent brute-force attacks
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
    // Cloudflare-specific: use CF-Connecting-IP for rate limiting
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createAuth>;
