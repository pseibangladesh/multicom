/**
 * Pure admin-access rules, kept free of React so they can be unit-tested.
 *
 * The server is the real gate: authMiddleware grants the admin role only to
 * sessions whose email is in ADMIN_EMAILS, and GET /api/auth/session mirrors
 * that as `user.is_admin`. These rules only decide what the UI shows.
 */
import type { AuthUser } from "./providers/auth-provider";

export type AdminAccess = "loading" | "login" | "forbidden" | "allowed";

export function adminAccess(state: {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: AuthUser | null;
}): AdminAccess {
  if (state.isLoading) return "loading";
  if (!state.isAuthenticated || !state.user) return "login";

  return state.user.is_admin === true ? "allowed" : "forbidden";
}

/** /login URL that brings the user back to `path` after signing in. */
export function loginRedirect(path: string): string {
  return `/login?returnTo=${encodeURIComponent(path)}`;
}
