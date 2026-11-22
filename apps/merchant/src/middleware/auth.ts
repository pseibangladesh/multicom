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
 * copies of the Software, to permit persons to whom the Software is
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

import { createMiddleware } from 'hono/factory';
import { getDb } from '../db';
import { ApiError, now, type AuthRole, type Env, type HonoEnv } from '../types';
import { hasSessionCookie, isAdminEmail, verifySession } from '../lib/session';

function merchantStub(env: Env) {
  return env.MERCHANT.get(env.MERCHANT.idFromName('default'));
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

/**
 * Authentication middleware for admin/OAuth-protected routes.
 *
 * Accepts three token formats (in priority order):
 * 1. **Better Auth session cookie** — secure HttpOnly cookie set by /api/auth/*
 *    Verified by Better Auth inside MerchantDO; grants admin only for ADMIN_EMAILS.
 * 2. **Admin API key** (`sk_` prefix) — stored in the database.
 * 3. **OAuth key** (64-char hex) — scoped API key.
 */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const db = getDb(c.var.db);
  const stripeSecretKey = c.env.STRIPE_SECRET_KEY || null;
  const stripeWebhookSecret = c.env.STRIPE_WEBHOOK_SECRET || null;

  // ── Priority 1: Better Auth session cookie ────────────────────────
  // Only sessions whose email is listed in ADMIN_EMAILS get admin; any other
  // session (e.g. a customer) falls through to the Bearer checks below.
  const cookieHeader = c.req.header('cookie');
  if (hasSessionCookie(cookieHeader)) {
    try {
      const session = await verifySession(merchantStub(c.env), cookieHeader);
      if (session && isAdminEmail(session.email, c.env.ADMIN_EMAILS)) {
        c.set('auth', {
          role: 'admin',
          stripeSecretKey,
          stripeWebhookSecret,
          email: session.email,
          name: session.name ?? undefined,
          userId: session.userId,
        });
        await next();
        return;
      }
    } catch (err) {
      console.warn('Better Auth session verification failed:', err);
    }
  }

  // ── Priority 2: Bearer token (OAuth or API key) ──────────────────
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const isOAuthToken = token.length === 64 && /^[a-f0-9]+$/.test(token);

  // ── Priority 3: OAuth token (64-char hex) ────────────────────────
  if (isOAuthToken) {
    const tokenHash = await hashKey(token);
    const oauthResult = await db.query<any>(
      `SELECT t.*, c.email as customer_email
       FROM oauth_tokens t
       JOIN customers c ON t.customer_id = c.id
       WHERE t.access_token_hash = ? AND t.access_expires_at > ?
       LIMIT 1`,
      [tokenHash, now()]
    );

    if (oauthResult.length > 0) {
      const row = oauthResult[0];
      c.set('auth', {
        role: 'oauth',
        stripeSecretKey,
        stripeWebhookSecret,
        oauthScopes: row.scope?.split(' ') || [],
        customerEmail: row.customer_email,
      });

      await next();
      return;
    }
  }

  // ── Priority 4: API key (sk_ or pk_ prefix) ──────────────────────
  const keyHash = await hashKey(token);
  const result = await db.query<any>(
    `SELECT role FROM api_keys WHERE key_hash = ? LIMIT 1`,
    [keyHash]
  );

  if (result.length === 0) {
    throw ApiError.unauthorized('Invalid API key');
  }

  c.set('auth', {
    role: result[0].role,
    stripeSecretKey,
    stripeWebhookSecret,
  });

  await next();
});

// ── Role-gate middleware (unchanged from previous implementation) ──

export const superAdminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('authadmin')) {
      console.warn('Superadmin access required, but user has roles:', auth.role);
      throw ApiError.forbidden('Superadmin access required');
    }
  } else if (auth.role !== 'authadmin') {
    console.warn('Superadmin access required, but user has role:', auth.role);
    throw ApiError.forbidden('Superadmin access required');
  }

  await next();
});

export const databaseAdminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('databaseadmin')) {
      console.warn('Database admin access required, but user has roles:', auth.role);
      throw ApiError.forbidden('Database admin access required');
    }
  } else if (auth.role !== 'databaseadmin') {
    console.warn('Database admin access required, but user has role:', auth.role);
    throw ApiError.forbidden('Database admin access required');
  }

  await next();
});

export const aiAccessOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('aiadmin')) {
      console.warn('AI admin access required, but user has roles:', auth.role);
      throw ApiError.forbidden('AI admin access required');
    }
  } else if (auth.role !== 'aiadmin') {
    console.warn('AI admin access required, but user has role:', auth.role);
    throw ApiError.forbidden('AI admin access required');
  }

  await next();
});

export const adminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('admin')) {
      console.warn('Admin access required, but user has roles:', auth.role);
      throw ApiError.forbidden('Admin access required');
    }
  } else if (auth.role !== 'admin') {
    console.warn('Admin access required, but user has role:', auth.role);
    throw ApiError.forbidden('Admin access required');
  }

  await next();
});

export const mailAccessOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');

  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('mail')) {
      console.warn('Mail API access required, but user has roles:', auth.role);
      throw ApiError.forbidden('Mail API access required');
    }
  } else if (auth.role !== 'mail') {
    console.warn('Mail API access required, but user has role:', auth.role);
    throw ApiError.forbidden('Mail API access required');
  }

  await next();
});

/**
 * Customer authentication middleware — verifies Better Auth session cookie.
 * Used for customer-facing routes like /v1/me/*, /v1/downloads, etc.
 */
export const customerAuthMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const cookieHeader = c.req.header('cookie');
  if (hasSessionCookie(cookieHeader)) {
    try {
      const session = await verifySession(merchantStub(c.env), cookieHeader);
      if (session) {
        c.set('auth', {
          role: 'customer',
          email: session.email,
          name: session.name ?? undefined,
          userId: session.userId,
          stripeSecretKey: null,
          stripeWebhookSecret: null,
        });
        await next();
        return;
      }
    } catch (err) {
      console.warn('Better Auth session verification failed:', err);
    }
  }

  throw ApiError.unauthorized('Missing or invalid session');
});

export function requireScope(...requiredScopes: string[]) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const auth = c.get('auth');

    if (auth.role === 'oauth') {
      const hasAllScopes = requiredScopes.every(
        (scope) => auth.oauthScopes?.includes(scope)
      );
      if (!hasAllScopes) {
        throw ApiError.forbidden(`Required scopes: ${requiredScopes.join(', ')}`);
      }
    }

    await next();
  });
}

export async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${key}`;
}
