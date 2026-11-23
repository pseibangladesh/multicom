/**
 * Better Auth session verification for the Worker side.
 *
 * Session cookies are HMAC-signed by Better Auth and the session rows live in
 * MerchantDO, so the Worker asks the DO's Better Auth instance to verify the
 * cookie (GET /api/auth/get-session) instead of reading the table directly.
 */

export interface VerifiedSession {
  userId: string;
  email: string;
  name: string | null;
  /** False for accounts from before sign-in required a verified email. */
  emailVerified?: boolean;
}

/** Anything that can serve a fetch, e.g. a DurableObjectStub. */
/**
 * What verifySession needs from MerchantDO (an RPC method on the stub).
 *
 * It must NOT go through Better Auth's HTTP handler (/api/auth/get-session):
 * that endpoint is rate limited, and an internal request carries no client IP,
 * so every user shared one 10-per-minute bucket and the 11th authenticated API
 * request in a minute, site-wide, failed with 401.
 */
export interface SessionVerifier {
  getSessionForCookie(cookieHeader: string): Promise<VerifiedSession | null>;
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return !!cookieHeader && SESSION_COOKIE.test(cookieHeader);
}

export async function verifySession(
  target: SessionVerifier,
  cookieHeader: string | null | undefined
): Promise<VerifiedSession | null> {
  if (!hasSessionCookie(cookieHeader)) return null;
  const session = await target.getSessionForCookie(cookieHeader as string);
  return session?.userId && session.email ? session : null;
}

export function isAdminEmail(email: string, adminEmails: string | undefined): boolean {
  if (!adminEmails) return false;
  const target = email.trim().toLowerCase();
  return adminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

/**
 * Browser origins allowed to send credentialed (cookie) requests:
 * CORS_ORIGIN (comma-separated), falling back to STORE_URL.
 */
export function allowedOrigins(env: { CORS_ORIGIN?: string; STORE_URL?: string }): string[] {
  return (env.CORS_ORIGIN || env.STORE_URL || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}
