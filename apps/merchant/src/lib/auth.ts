import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import * as schema from '../db/schema';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { allowedOrigins, isAdminEmail } from './session';

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  ADMIN_EMAILS?: string;
  API_BASE_URL?: string;
  CORS_ORIGIN?: string;
  STORE_URL?: string;
}

/**
 * Creates the Better Auth instance. Must be called INSIDE MerchantDO:
 * DurableObjectStorage is only reachable from the object itself, not from a
 * stub in the Worker. The Worker forwards /api/auth/* to the DO (see do.ts).
 */
/** Better Auth signs session cookies with this; short or missing secrets are forgeable. */
export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Fails closed instead of letting Better Auth fall back to its built-in
 * development secret, which is public. The message never includes the value.
 */
export function assertAuthSecret(secret: string | undefined): string {
  if (!secret || secret.trim().length < MIN_AUTH_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET must be set to at least ${MIN_AUTH_SECRET_LENGTH} characters ` +
        '(generate one with `openssl rand -base64 32`, then `wrangler secret put BETTER_AUTH_SECRET`)'
    );
  }
  return secret;
}

export function createAuth(env: AuthEnv, storage: DurableObjectStorage) {
  const secret = assertAuthSecret(env.BETTER_AUTH_SECRET);
  const db = drizzle(storage, { schema });
  const baseURL = env.API_BASE_URL || 'http://127.0.0.1:8787';

  return betterAuth({
    baseURL,
    basePath: '/api/auth',
    secret,
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
    hooks: {
      // Admin rights come from ADMIN_EMAILS, and email verification is off, so
      // whoever signs up first with such an address would become admin. Admin
      // accounts are created with scripts/create-admin.ts instead (it uses the
      // internal adapter, which this endpoint hook does not affect).
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email') return;
        const email: unknown = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && isAdminEmail(email, env.ADMIN_EMAILS)) {
          throw new APIError('FORBIDDEN', { message: 'Sign-up is not available for this email address.' });
        }
      }),
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
