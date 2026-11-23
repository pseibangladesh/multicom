/**
 * The authentication contract used by the whole client.
 *
 * Implemented by the Better Auth provider (local-provider.tsx): sessions are
 * an HttpOnly cookie set by the merchant worker's /api/auth/* endpoints, so
 * there are no access tokens on the client.
 */
import type { FC } from "react";

/** The signed-in user, from GET /api/auth/session. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
  /** UI hint only (email in ADMIN_EMAILS); the API enforces admin access itself. */
  is_admin?: boolean;
}

export interface LoginOptions {
  /** Path to come back to after signing in. */
  returnTo?: string;
  /** Prefills the email field. */
  email?: string;
  /** Open the form in "create account" mode. */
  mode?: "signin" | "signup";
}

export interface LogoutOptions {
  /** Where to go after signing out (defaults to the store's home page). */
  returnTo?: string;
}

/** Sign-in refused because the address hasn't been confirmed yet (a new link was emailed). */
export class EmailNotVerifiedError extends Error {
  constructor(message = "Please confirm your email address first.") {
    super(message);
    this.name = "EmailNotVerifiedError";
  }
}

export interface AuthProvider {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;

  /** Sends the browser to the /login page. */
  login(options?: LoginOptions): Promise<void>;
  logout(options?: LogoutOptions): Promise<void>;
  /** Re-reads the session from the server. */
  refreshSession(): Promise<void>;

  /** Throws EmailNotVerifiedError, or an Error with the server's message. */
  signInEmail(email: string, password: string): Promise<void>;
  /**
   * Creates the account and emails a confirmation link. The user is signed in
   * when they open that link, not by this call.
   */
  signUpEmail(name: string, email: string, password: string): Promise<void>;
  /** Emails a new confirmation link. */
  resendVerification(email: string): Promise<void>;

  /** UI hint: the session is an admin (ADMIN_EMAILS). The API checks for itself. */
  isAdmin: boolean;

  // JSON helpers that send the session cookie. `any`: response shapes vary by
  // endpoint and callers type them.

  getJson(url: string): Promise<any>;
  postJson(url: string, data: unknown): Promise<any>;
  postForm(url: string, formData: FormData): Promise<any>;
  putJson(url: string, data: unknown): Promise<any>;
  patchJson(url: string, data: unknown): Promise<any>;
  deleteJson(url: string): Promise<any>;
}

export interface AuthGuardProps {
  component: FC;
}
