import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { Env, DOStub } from '../types';
// Import your Drizzle schema definitions here
import * as schema from '../db/schema';

/**
 * Creates a Better Auth instance bound to the current request's environment.
 * Called per-request so each worker invocation gets its own auth config.
 */
export function createAuth(env: Env & { MERCHANT: any }) {
  const id = env.MERCHANT.idFromName('default');
  const stub = env.MERCHANT.get(id);

  // The Drizzle driver for Durable Objects requires the storage object.
  // We access it via the stub's `storage` property.
  const db = drizzle(stub.storage, { schema });

  return betterAuth({
    baseURL: env.API_BASE_URL || 'http://127.0.0.1:8787',
    secret: env.BETTER_AUTH_SECRET,
    // Use the official adapter with the correct SQLite provider
    database: drizzleAdapter(db, {
      provider: 'sqlite',
    }),
    // ... rest of your config (emailAndPassword, session, etc.)
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
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createAuth>;