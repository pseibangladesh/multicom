/**
 * Better Auth API routes mounted at /api/auth/*
 *
 * Handles: POST /api/auth/sign-in/email, POST /api/auth/sign-up/email,
 *           POST /api/auth/sign-out, GET /api/auth/session, etc.
 *
 * These endpoints replace the previous Auth0 redirect flow and the
 * `/v1/__auth0/*` Management API proxy routes.
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { createAuth } from '../lib/auth';

/**
 * Creates a Hono app that delegates to Better Auth's request handler.
 * Mount this at `/api/auth` in your main worker.
 */
export function createAuthRouter(env: Env & { MERCHANT: any }) {
  const auth = createAuth(env);

  const app = new Hono();

  // Delegate all /api/auth/* requests to Better Auth
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    return auth.handler(c.req.raw);
  });

  return app;
}

/**
 * Session check endpoint — returns the current session as JSON.
 * Useful for the frontend to verify auth state on page load.
 */
export function createSessionRouter(env: Env & { MERCHANT: any }) {
  const auth = createAuth(env);

  const app = new Hono();

  // GET /api/auth/session — check if user is logged in
  app.get('/', async (c) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session) {
      return c.json({ session: null }, 200);
    }

    // Map Better Auth user to our existing AuthContext shape for compatibility
    return c.json({
      session: {
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image,
        },
        token: (session as any).token,
      },
    }, 200);
  });

  return app;
}
