/**
 * Authentication module re-exports (Better Auth session cookies).
 */

export { useAuth } from "@/features/auth/providers/use-auth";
export { useLocalProvider } from "@/features/auth/providers/local-provider";
export { AuthenticationProvider } from "@/features/auth/auth-root";

export {
  EmailNotVerifiedError,
  type AuthProvider,
  type AuthUser,
  type LoginOptions,
  type LogoutOptions,
  type AuthGuardProps,
} from "@/features/auth/providers/auth-provider";

export {
  AuthenticationGuard,
  useSecuredApi,
} from "@/features/auth/components/auth-components";

export { AdminGuard } from "@/features/auth/components/admin-guard";
export {
  adminAccess,
  loginRedirect,
  type AdminAccess,
} from "@/features/auth/admin-access";
