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
}

/** Anything that can serve a fetch, e.g. a DurableObjectStub. */
export interface FetchTarget {
  fetch(request: Request): Promise<Response>;
}

const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

export function hasSessionCookie(cookieHeader: string | null | undefined): boolean {
  return !!cookieHeader && SESSION_COOKIE.test(cookieHeader);
}

export async function verifySession(
  target: FetchTarget,
  cookieHeader: string | null | undefined
): Promise<VerifiedSession | null> {
  if (!hasSessionCookie(cookieHeader)) return null;

  const res = await target.fetch(
    new Request('https://merchant-do/api/auth/get-session', {
      headers: { cookie: cookieHeader as string },
    })
  );
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as {
    user?: { id?: string; email?: string; name?: string | null };
  } | null;
  const user = body?.user;
  if (!user?.id || !user.email) return null;

  return { userId: user.id, email: user.email, name: user.name ?? null };
}

/**
 * A session only grants admin when its email is listed in ADMIN_EMAILS
 * (comma-separated). Customers sign up through the same Better Auth instance,
 * so "has a session" must never mean "is an admin".
 */
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
