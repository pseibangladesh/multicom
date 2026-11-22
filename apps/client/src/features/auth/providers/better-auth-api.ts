/**
 * Minimal Better Auth HTTP client. Better Auth runs on the merchant worker
 * (forwarded into MerchantDO), not on the SPA's origin, so every call goes to
 * the API base with credentials: "include" to send/receive the session cookie.
 */
import { getApiBase } from "@/lib/api-base";

export const authUrl = (path: string): string =>
  `${getApiBase()}/api/auth${path}`;

/** POSTs JSON; throws an Error carrying the server's message on failure. */
export async function authPost(path: string, body: unknown): Promise<void> {
  const resp = await fetch(authUrl(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => null);

    throw new Error(data?.message || `HTTP ${resp.status}`);
  }
}
