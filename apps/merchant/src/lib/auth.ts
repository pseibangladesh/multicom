import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as schema from '../db/schema';
import { allowedOrigins } from './session';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  API_BASE_URL?: string;
  CORS_ORIGIN?: string;
  STORE_URL?: string;
}

/**
 * Creates the Better Auth instance. Must be called INSIDE MerchantDO:
 * DurableObjectStorage is only reachable from the object itself, not from a
 * stub in the Worker. The Worker forwards /api/auth/* to the DO (see do.ts).
 */
export function createAuth(env: AuthEnv, storage: DurableObjectStorage) {
  const db = drizzle(storage, { schema });
  const baseURL = env.API_BASE_URL || 'http://127.0.0.1:8787';

  return betterAuth({
    baseURL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    // The storefront runs on another origin; Better Auth rejects sign-in/up
    // requests whose Origin isn't trusted.
    trustedOrigins: allowedOrigins(env),
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url }) => {
        console.log(`[Auth] Password reset requested for user ${user.email}, url=${url}`);
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
    advanced: {
      // Always enforce the Origin (CSRF) check; Better Auth otherwise turns it
      // off when it detects a test environment.
      disableOriginCheck: false,
      // In production the store (e.g. GitHub Pages) and API are different sites,
      // so the cookie must be SameSite=None; Secure. Locally (http://localhost
      // on both ports) the default Lax cookie is same-site and works.
      ...(baseURL.startsWith('https://') && {
        defaultCookieAttributes: { sameSite: 'none' as const, secure: true },
      }),
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createAuth>;
