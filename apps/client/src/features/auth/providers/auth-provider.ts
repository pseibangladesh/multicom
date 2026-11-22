/**
 * @copyright Copyright (c) 2024-2026 Ronan LE MEILLAT
 * @license AGPL-3.0-or-later
 */

import { FC, JSX } from "react";

/**
 * Interface for the common user properties across all auth providers
 */
export interface AuthUser {
  name?: string;
  nickname?: string;
  email?: string;
  sub?: string;
  [key: string]: any;
}

/**
 * Interface for token options
 */
export interface TokenOptions {
  audience?: string;
  scope?: string;
  [key: string]: any;
}

/**
 * Interface for logout options
 */
export interface LogoutOptions {
  logoutParams?: {
    returnTo?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Interface for login options
 */
export interface LoginOptions {
  [key: string]: any;
}

/**
 * Core interface that all authentication providers must implement
 */
export interface AuthProvider {
  // Authentication state
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;

  // Core authentication methods
  login(options?: LoginOptions): Promise<void>;
  logout(options?: LogoutOptions): Promise<void>;
  getAccessToken(options?: TokenOptions): Promise<string | null>;
  refreshAccessToken(options?: TokenOptions): Promise<string | null>;

  // Better Auth email/password. Both resolve on success (session cookie set)
  // and throw an Error with the server's message on failure.
  signInEmail(email: string, password: string): Promise<void>;
  signUpEmail(name: string, email: string, password: string): Promise<void>;

  // Permission handling
  hasPermission(permission: string): Promise<boolean>;

  // API interaction helpers
  getJson(url: string): Promise<any>;
  postJson(url: string, data: any): Promise<any>;
  postForm(url: string, formData: FormData): Promise<any>;
  putJson(url: string, data: any): Promise<any>;
  patchJson(url: string, data: any): Promise<any>;
  deleteJson(url: string): Promise<any>;
}

/**
 * Provider configuration interface
 */
export interface AuthProviderConfig {
  domain: string;
  clientId: string;
  redirectUri: string;
  audience?: string;
  scope?: string;
  jwksEndpoint?: string;
  tokenIssuer?: string;
  [key: string]: any;
}

/**
 * Interface for components requiring authentication
 */
export interface WithAuthenticationOptions {
  onRedirecting?: () => JSX.Element;
  returnTo?: string | (() => string);
}

/**
 * Interface for authentication guard components
 */
export interface AuthGuardProps {
  component: FC;
  onRedirecting?: () => JSX.Element;
}

/**
 * Factory function type for creating authentication providers
 */
export type AuthProviderFactory = (config: AuthProviderConfig) => AuthProvider;
