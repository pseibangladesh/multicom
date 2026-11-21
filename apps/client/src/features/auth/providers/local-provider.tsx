/**
 * Local (Better Auth) implementation of the AuthProvider interface.
 *
 * Uses session cookies set by /api/auth/* endpoints on the backend.
 * No external SDK needed — just standard fetch with cookie-based sessions.
 */

import { useEffect, useState, useCallback } from "react";
import { getBaseURL } from "@/utils/base-url";
import { AuthProvider, AuthUser, TokenOptions, LogoutOptions, LoginOptions } from "./auth-provider";

/**
 * Local provider that works with Better Auth session cookies.
 */
export const useLocalProvider = (): AuthProvider => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check session status on mount and after navigation
  const checkSession = useCallback(async () => {
    try {
      const apiBase = getBaseURL() || "";
      const resp = await fetch(`${apiBase}/api/auth/session`);
      const data = await resp.json();

      if (data.session) {
        setUser(data.session.user);
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

  const login = async (_options?: LoginOptions): Promise<void> => {
    // Redirect to the backend's /api/auth/sign-in/email or show a login form
    window.location.href = `${getBaseURL() || ""}/login`;
  };

  const logout = async (_options?: LogoutOptions): Promise<void> => {
    try {
      const apiBase = getBaseURL() || "";
      await fetch(`${apiBase}/api/auth/sign-out`, { method: "POST" });
    } catch (err) {
      console.error("[Local Auth] Signout failed:", err);
    }
    setUser(null);
    setIsAuthenticated(false);

    const returnTo = _options?.logoutParams?.returnTo || window.location.origin;
    window.location.href = returnTo;
  };

  const getAccessToken = async (_options?: TokenOptions): Promise<string | null> => {
    // Better Auth uses session cookies — no explicit access token needed
    // Return a placeholder so existing code doesn't break
    return "session";
  };

  const refreshAccessToken = async (_options?: TokenOptions): Promise<string | null> => {
    await checkSession();
    return "session";
  };

  const hasPermission = useCallback(async (_permission: string): Promise<boolean> => {
    // Better Auth permissions are handled server-side via role checks
    // For now, authenticated users have full access
    return isAuthenticated;
  }, [isAuthenticated]);

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
