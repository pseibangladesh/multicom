/**
 * Minimal Better Auth HTTP client. Better Auth runs on the merchant worker
 * (forwarded into MerchantDO), not on the SPA's origin, so every call goes to
 * the API base with credentials: "include" to send/receive the session cookie.
 */
import { getApiBase } from "@/lib/api-base";

export const authUrl = (path: string): string =>
  `${getApiBase()}/api/auth${path}`;

/** A failed Better Auth call: the server's message, plus its error code (e.g. EMAIL_NOT_VERIFIED). */
export class AuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

/** POSTs JSON; throws AuthApiError on failure. */
export async function authPost(path: string, body: unknown): Promise<void> {
  const resp = await fetch(authUrl(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const data = (await resp.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;

    throw new AuthApiError(
      data?.message || `HTTP ${resp.status}`,
      resp.status,
      data?.code,
    );
  }
}
