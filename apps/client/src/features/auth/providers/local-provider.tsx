/**
 * Local (Better Auth) implementation of the AuthProvider interface.
 *
 * Uses session cookies set by /api/auth/* endpoints on the backend.
 * No external SDK needed — just standard fetch with cookie-based sessions.
 */

import { useEffect, useState, useCallback } from "react";

import {
  AuthProvider,
  AuthUser,
  TokenOptions,
  LogoutOptions,
  LoginOptions,
} from "./auth-provider";

import { getBaseURL } from "@/utils/base-url";
import { getApiBase } from "@/lib/api-base";

/** Better Auth lives on the merchant worker, not on the SPA's origin. */
const authUrl = (path: string) => `${getApiBase()}/api/auth${path}`;

async function authPost(path: string, body: unknown): Promise<void> {
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

export const useLocalProvider = (): AuthProvider => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const resp = await fetch(authUrl("/session"), { credentials: "include" });
      const data = resp.ok ? await resp.json() : null;

      if (data?.session?.user) {
        const u = data.session.user;

        setUser({ ...u, sub: u.id });
        setIsAuthenticated(true);
      } else {
        setUser(null);
        setIsAuthenticated(false);
      }
    } catch (err) {
      console.error("[Local Auth] Session check failed:", err);
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  /**
   * Sends the user to the /login page. Accepts the old Auth0-style options so
   * existing callers keep working: appState.returnTo, authorizationParams.login_hint
   * and authorizationParams.screen_hint === "signup".
   */
  const login = async (options?: LoginOptions): Promise<void> => {
    const params = new URLSearchParams();
    const returnTo = options?.appState?.returnTo ?? options?.returnTo;

    if (returnTo) params.set("returnTo", returnTo);
    if (options?.authorizationParams?.login_hint)
      params.set("email", options.authorizationParams.login_hint);
    if (options?.authorizationParams?.screen_hint === "signup")
      params.set("mode", "signup");
    const query = params.toString();

    window.location.href = `${getBaseURL()}/login${query ? `?${query}` : ""}`;
  };

  const signInEmail = async (
    email: string,
    password: string,
  ): Promise<void> => {
    await authPost("/sign-in/email", { email, password });
    await checkSession();
  };

  const signUpEmail = async (
    name: string,
    email: string,
    password: string,
  ): Promise<void> => {
    await authPost("/sign-up/email", { name, email, password });
    await checkSession();
  };

  const logout = async (options?: LogoutOptions): Promise<void> => {
    try {
      await authPost("/sign-out", {});
    } catch (err) {
      console.error("[Local Auth] Signout failed:", err);
    }
    setUser(null);
    setIsAuthenticated(false);

    window.location.href =
      options?.logoutParams?.returnTo || window.location.origin;
  };

  const getAccessToken = async (
    _options?: TokenOptions,
  ): Promise<string | null> => {
    // Better Auth uses an HttpOnly session cookie; there is no bearer token.
    // Kept for interface compatibility.
    return isAuthenticated ? "session" : null;
  };

  const refreshAccessToken = async (
    _options?: TokenOptions,
  ): Promise<string | null> => {
    await checkSession();

    return "session";
  };

  const hasPermission = useCallback(
    async (_permission: string): Promise<boolean> => {
      // Only ADMIN_EMAILS sessions have admin access server-side; is_admin
      // mirrors that so customers aren't shown admin-only UI.
      return isAuthenticated && user?.is_admin === true;
    },
    [isAuthenticated, user],
  );

  // API helpers that automatically include session cookies
  const getJson = async (url: string): Promise<any> => {
    const resp = await fetch(url, { credentials: "include" });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  const postJson = async (url: string, data: any): Promise<any> => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  const postForm = async (url: string, formData: FormData): Promise<any> => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      body: formData,
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  const deleteJson = async (url: string): Promise<any> => {
    const resp = await fetch(url, {
      method: "DELETE",
      credentials: "include",
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  const putJson = async (url: string, data: any): Promise<any> => {
    const resp = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  const patchJson = async (url: string, data: any): Promise<any> => {
    const resp = await fetch(url, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    return resp.json();
  };

  return {
    isAuthenticated,
    isLoading,
    user,
    login,
    logout,
    signInEmail,
    signUpEmail,
    getAccessToken,
    refreshAccessToken,
    hasPermission,
    getJson,
    postJson,
    postForm,
    deleteJson,
    putJson,
    patchJson,
  };
};
