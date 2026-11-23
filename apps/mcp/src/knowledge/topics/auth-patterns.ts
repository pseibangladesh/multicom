/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */
import type { Topic } from '../base.js';
import { BASE_SYSTEM, appendFacts } from '../base.js';

const topic: Topic = {
  name: 'auth-patterns',
  description: 'Better Auth sessions with email verification, authMiddleware/customerAuthMiddleware, the adminOnly guard (ADMIN_EMAILS), API keys and OAuth tokens, and the frontend AuthenticationGuard/AdminGuard.',
  tags: ["auth","better-auth","frontend","react","security","ui"],
  sources: [
    'apps/merchant/src/middleware/auth.ts',
    'apps/merchant/src/middleware/customer-auth.ts',
    'apps/merchant/src/types.ts',
  ],
  systemPrompt: BASE_SYSTEM,
  manualFacts: [
    'Better Auth (apps/merchant/src/lib/auth.ts) is the only identity system. It runs inside MerchantDO on DO SQLite (Drizzle adapter); the Worker forwards /api/auth/* to the DO. Sessions are an HttpOnly cookie.',
    'Email + password accounts must confirm their address (requireEmailVerification). Sign-up emails a link (Mailgun via lib/auth-email.ts; without Mailgun the link is logged with console.warn) and does not create a session; GET /api/auth/verify-email?token=… verifies and signs in. Signing in unverified returns 403 code EMAIL_NOT_VERIFIED and re-sends the link. POST /api/auth/send-verification-email re-sends on request.',
    'Admins are the users whose email is in the ADMIN_EMAILS env var (comma-separated). There is no permission/role table and no RBAC dashboard. ADMIN_EMAILS users are marked verified automatically so they cannot be locked out.',
    'authMiddleware (apps/merchant/src/middleware/auth.ts) checks, in order: (1) Better Auth session cookie (role "admin" only for ADMIN_EMAILS, otherwise rejected); (2) 64-char hex OAuth token (role "oauth", scopes); (3) sk_ admin key / pk_ public key, SHA-256 hashed in api_keys.',
    'AuthRole is "public" | "admin" | "oauth" | "customer", stored in c.var.auth.role.',
    'Guards: adminOnly (role must be "admin") protects every admin route, including setup/migrations, mail and AI settings. requireScope(...scopes) checks OAuth token scopes.',
    'customerAuthMiddleware (also in middleware/auth.ts; middleware/customer-auth.ts re-exports it) is for /v1/me/* and other customer routes. It needs a verified Better Auth session (403 "Please verify your email address first" otherwise), sets role "customer" and auth.userId.',
    'Customer data is always looked up from the session: resolveCustomer(db, userId) in apps/merchant/src/lib/customers.ts maps the Better Auth user to a customers row (claiming it by email and linking earlier guest orders on first use). Never take a customer id or email from the request body.',
    'Frontend: AuthenticationGuard (prop component) sends signed-out visitors to /login?returnTo=…; AdminGuard wraps /admin and only lets ADMIN_EMAILS sessions (user.is_admin) through. useAuth().isAdmin / useSecuredApi().isAdmin is the UI hint for admin-only buttons; the API enforces access itself.',
    'Frontend sign-in and sign-up use EmailAuthForm (features/auth/components/email-auth-form.tsx) on the /login page and in LoginModal; after sign-up it shows a "check your email" step with a resend button.',
  ],
  buildPrompt: (src) => appendFacts(`
Below are the authentication middleware files and the types definition.

${src}

Task: Write a unified "Authentication Patterns" reference covering both backend middleware and frontend guards.
Include:
1. The three credential types accepted (Better Auth session cookie, OAuth hex token, sk_/pk_ API key) and the email-verification rule.
2. AuthRole values and when each role is assigned.
3. Backend: complete table of all RBAC guards, the role they check, and typical use case.
4. Backend: code example — protecting a route with authMiddleware + adminOnly.
5. Backend: how ADMIN_EMAILS decides who is an admin.
6. Backend: customerAuthMiddleware for customer-scoped routes.
7. Frontend: AuthenticationGuard (prop: component), AdminGuard, isAdmin and isAuthenticated from useAuth() — when to use each.
8. Frontend: EmailAuthForm / LoginModal — sign-in, sign-up and the email confirmation step.
9. resolveCustomer(): how a session maps to customer data.
10. requireScope(...scopes) factory for OAuth-scoped routes.
`, topic.manualFacts),
};

export default topic;
