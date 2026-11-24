/**
 * Better Auth implementation of the AuthProvider interface.
 *
 * Uses the session cookie set by the merchant worker's /api/auth/* endpoints;
 * no SDK and no tokens on the client.
 */

import { useEffect, useState, useCallback } from "react";

import {
  AuthProvider,
  AuthUser,
  EmailNotVerifiedError,
  LogoutOptions,
  LoginOptions,
} from "./auth-provider";
import { AuthApiError, authPost, authUrl } from "./better-auth-api";

import { getBaseURL } from "@/utils/base-url";

/**
 * Where the emailed confirmation link lands: the login page, which then
 * continues to `returnTo`. Absolute, and on the store's origin (a trusted
 * origin on the server).
 */
export function verifyCallbackURL(returnTo?: string): string {
  const params = new URLSearchParams({ verified: "1" });

  if (returnTo) params.set("returnTo", returnTo);

  return `${window.location.origin}${getBaseURL()}/login?${params}`;
}

export const useLocalProvider = (): AuthProvider => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const resp = await fetch(authUrl("/session"), { credentials: "include" });
      const data = resp.ok
        ? ((await resp.json()) as { session?: { user?: AuthUser } | null })
        : null;

      if (data?.session?.user) {
        setUser(data.session.user);
        setIsAuthenticated(true);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (err) {
      console.error("[Auth] Session check failed:", err);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const login = async (options?: LoginOptions): Promise<void> => {
    const params = new URLSearchParams();

    if (options?.returnTo) params.set("returnTo", options.returnTo);
    if (options?.email) params.set("email", options.email);
    if (options?.mode === "signup") params.set("mode", "signup");
    const query = params.toString();

    window.location.href = `${getBaseURL()}/login${query ? `?${query}` : ""}`;
  };

  const signInEmail = async (
    email: string,
    password: string,
  ): Promise<void> => {
    try {
      await authPost("/sign-in/email", {
        email,
        password,
        // Used by the fresh confirmation link sent to unverified accounts.
        callbackURL: verifyCallbackURL(),
      });
    } catch (err) {
      if (err instanceof AuthApiError && err.code === "EMAIL_NOT_VERIFIED") {
        throw new EmailNotVerifiedError();
      }
      throw err;
    }
    await checkSession();
  };

  const signUpEmail = async (
    name: string,
    email: string,
    password: string,
  ): Promise<void> => {
    // No session yet: the account is usable once the emailed link is opened.
    await authPost("/sign-up/email", {
      name,
      email,
      password,
      callbackURL: verifyCallbackURL(),
    });
  };

  const resendVerification = async (email: string): Promise<void> => {
    await authPost("/send-verification-email", {
      email,
      callbackURL: verifyCallbackURL(),
    });
  };

  const logout = async (options?: LogoutOptions): Promise<void> => {
    try {
      await authPost("/sign-out", {});
    } catch (err) {
      console.error("[Auth] Sign-out failed:", err);
    }
    setUser(null);
    setIsAuthenticated(false);

    // A full reload clears every per-user cache (queries, cart) in memory.
    window.location.href =
      options?.returnTo ||
      new URL(getBaseURL() || "/", window.location.origin).toString();
  };

  // Only ADMIN_EMAILS sessions have admin access server-side; is_admin mirrors
  // that so customers aren't shown admin-only UI (AI, test mail…).
  const isAdmin = isAuthenticated && user?.is_admin === true;

  // API helpers that automatically include session cookies
  // "HTTP <status>" stays first (isConflictError matches on it); the API's
  // own error message is appended so pages can show why a request failed.
  const httpError = async (resp: Response): Promise<Error> => {
    let detail = "";

    try {
      const body = (await resp.json()) as {
        error?: { message?: string } | string;
      };

      detail =
        typeof body.error === "string"
          ? body.error
          : (body.error?.message ?? "");
    } catch {
      // Not JSON: keep the status only.
    }

    return new Error(
      detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`,
    );
  };

  const getJson = async (url: string): Promise<any> => {
    const resp = await fetch(url, { credentials: "include" });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  const postJson = async (url: string, data: unknown): Promise<any> => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  const postForm = async (url: string, formData: FormData): Promise<any> => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  const deleteJson = async (url: string): Promise<any> => {
    const resp = await fetch(url, {
      method: "DELETE",
      credentials: "include",
    });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  const putJson = async (url: string, data: unknown): Promise<any> => {
    const resp = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  const patchJson = async (url: string, data: unknown): Promise<any> => {
    const resp = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw await httpError(resp);

    return resp.json();
  };

  return {
    isAuthenticated,
    isLoading,
    user,
    login,
    logout,
    refreshSession: checkSession,
    signInEmail,
    signUpEmail,
    resendVerification,
    isAdmin,
    getJson,
    postJson,
    postForm,
    deleteJson,
    putJson,
    patchJson,
  };
};
