/**
 * Authentication module re-exports.
 *
 * Default provider is "local" (Better Auth session cookies).
 */

// Re-export components and hooks
export {
  useAuth,
  getNameWithFallback,
  withAuthentication,
} from "@/features/auth/providers/use-auth";

// Local provider (Better Auth) — default
export { useLocalProvider } from "@/features/auth/providers/local-provider";

export {
  AuthenticationProvider,
  type AuthenticationType,
} from "@/features/auth/auth-root";

// Export interfaces
export type {
  AuthProvider,
  AuthUser,
  TokenOptions,
  LoginOptions,
  LogoutOptions,
  AuthProviderConfig,
  AuthGuardProps,
  AuthPermissionGuardProps,
} from "@/features/auth/providers/auth-provider";

// Export UI components
export {
  Profile,
  LoginButton,
  LoginLink,
  LogoutButton,
  LogoutLink,
  LoginLogoutButton,
  LoginLogoutLink,
  AuthenticationGuard,
  AuthenticationGuardWithPermission,
  useSecuredApi,
} from "@/features/auth/components/auth-components";
