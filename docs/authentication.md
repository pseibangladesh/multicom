# Multicom — Authentication System (End-to-End)

**Version:** 1.0 | **Date:** 2026-11-21

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication Methods](#2-authentication-methods)
3. [Session-Based Auth (Better Auth)](#3-session-based-auth-better-auth)
4. [API Key Authentication](#4-api-key-authentication)
5. [OAuth Token Authentication](#5-oauth-token-authentication)
6. [Order View Tokens](#6-order-view-tokens)
7. [Role-Based Access Control](#7-role-based-access-control)
8. [Frontend Integration](#8-frontend-integration)
9. [Data Model](#9-data-model)

---

## 1. Overview

Multicom uses a **multi-layer authentication system** that supports three distinct methods:

| Layer | Method | Token Format | Use Case |
|-------|--------|-------------|----------|
| 1 | Better Auth session cookie | `better-auth.session_token=***` (HttpOnly) | Admin dashboard + customer portal |
| 2 | API keys | `sk_*` (admin) / `pk_*` (public) | Server-to-server integrations |
| 3 | OAuth tokens | 64-character hex string | Third-party marketplace integrations |

All methods are handled by middleware in the Cloudflare Worker, checked in priority order. People sign up and sign in with email + password directly on the platform (Better Auth); there is no external identity provider. New accounts must confirm their email address first.

---

## 2. Authentication Methods

### 2.1 Priority Order

Every incoming request is evaluated against these methods in sequence:

```
Request
 └─ Cookie header?
     ├─ better-auth.session_token present → Verify session (Priority 1)
     └─ No cookie or session invalid
         └─ Authorization: Bearer <token>
             ├─ 64-char hex → OAuth token (Priority 3)
             ├─ sk_* prefix → Admin API key (Priority 2a)
             └─ pk_* prefix → Public API key (Priority 2b)
```

### 2.2 Session Authentication Flow (Priority 1)

```
Frontend                          Backend Worker                  D1 Database
   │                                 │                              │
   │  GET /api/auth/session          │                              │
   │── cookie: better-auth.session=***─────────────►                │
   │                                 │ Hash token (SHA-256)         │
   │                                 │ SELECT * FROM sessions       │
   │                                 │ WHERE token = ? AND         │
   │                                 │ expires_at > now()          │
   │                                 │                              │
   │  { session: { user: {...} } }  │◄───────────────────── Returns matching row
   │                                 │                              │
```

### 2.3 API Key Authentication (Priority 2)

```
Request → Authorization: Bearer sk_abc123...
          │
          ▼ Worker extracts token
          │ Hash(token) = SHA-256("sk_abc123...")
          │
          ▼ DB lookup:
          │ SELECT role FROM api_keys WHERE key_hash = ? LIMIT 1
          │
          ├─ Match found → Set auth.role = result.role
          └─ No match → 401 Unauthorized
```

### 2.4 OAuth Token Authentication (Priority 3)

```
Request → Authorization: Bearer <64-char-hex>
          │
          ▼ Check pattern: /^[a-f0-9]{64}$/
          │
          ▼ Hash(token) = SHA-256(raw_token)
          │
          ▼ DB lookup:
          │ SELECT t.*, c.email
          │ FROM oauth_tokens t
          │ JOIN customers c ON t.customer_id = c.id
          │ WHERE access_token_hash = ? AND access_expires_at > now()
          │
          ├─ Match → Set auth.role = 'oauth', auth.oauthScopes
          └─ No match → Fall through to API key check
```

---

## 3. Session-Based Auth (Better Auth)

### 3.1 Sign Up, Email Confirmation and Sign In

Email + password accounts must confirm their address before they can sign in (`requireEmailVerification: true` in `apps/merchant/src/lib/auth.ts`). This stops anyone from signing up with someone else's email and taking over the guest orders placed with it.

```
Customer                          Worker → MerchantDO (Better Auth)        Mailgun
   │ POST /api/auth/sign-up/email     │                                     │
   │ { name, email, password,         │── INSERT INTO "user" (unverified)   │
   │   callbackURL }                  │── sendVerificationEmail ───────────►│── email with link
   │◄── 200, no session cookie        │                                     │
   │                                  │                                     │
   │ GET /api/auth/verify-email?token=…&callbackURL=…                       │
   │─────────────────────────────────►│── email_verified = 1                │
   │◄── 302 to callbackURL + session cookie (autoSignInAfterVerification)   │
```

- **Sign in** (`POST /api/auth/sign-in/email`): a wrong password gives 401. An unconfirmed account gives **403 `EMAIL_NOT_VERIFIED`**, and a new link is sent (`sendOnSignIn`).
- **Resend** (`POST /api/auth/send-verification-email { email, callbackURL }`).
- **Links** expire after 24 h. An invalid or expired link redirects to `callbackURL?error=…`; the storefront `/login` page shows "link invalid or expired".
- **Emails** are built by `lib/auth-email.ts` and sent through Mailgun (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`). Without Mailgun, the link is logged with `console.warn` — fine for local development, but **production must configure Mailgun** or customers can't confirm their accounts. Password-reset emails use the same path.
- **Admins** (`ADMIN_EMAILS`) are marked confirmed automatically when the auth instance starts and when their login is created, so they can't be locked out.

### 3.2 Session Verification in Middleware

The `authMiddleware` in `apps/merchant/src/middleware/auth.ts` handles session verification:

```typescript
// apps/merchant/src/middleware/auth.ts (lines 48-82)
const sessionCookie = c.req.header('cookie') || '';
const sessionMatch = sessionCookie.match(/better-auth\.session_token=([^;]+)/);

if (sessionMatch) {
  const token = sessionMatch[1];
  const hashedToken = await hashKey(token);  // SHA-256

  const sessionResult = await db.query<any>(
    `SELECT s.*, u.email, u.name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?
     LIMIT 1`,
    [hashedToken, now()]
  );

  if (sessionResult.length > 0) {
    const row = sessionResult[0];
    c.set('auth', {
      role: 'admin',
      stripeSecretKey,
      stripeWebhookSecret,
      email: row.email,
      name: row.name,
      userId: row.user_id,
    });
  }
}
```

### 3.3 Customer Authentication Middleware

For customer-facing routes (`/v1/me/*`, downloads, reviews, AI tokens), `customerAuthMiddleware` in `apps/merchant/src/middleware/auth.ts` verifies the Better Auth session through the DO (`lib/session.ts`) and:

- rejects API keys as a customer identity (401);
- rejects sessions whose email is not confirmed (**403** "Please verify your email address first");
- sets `c.var.auth = { role: 'customer', userId, email, name, … }`.

`middleware/customer-auth.ts` only re-exports it for older imports.

### 3.4 Better Auth Configuration

Defined in `apps/merchant/src/lib/auth.ts`:

```typescript
export function createAuth(env: Env & { MERCHANT: any }) {
  return betterAuth({
    baseURL: env.API_BASE_URL || 'http://127.0.0.1:8787',
    secret: env.BETTER_AUTH_SECRET,
    database: createD1Adapter(stub),

    // Email + password authentication
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      sendResetPassword: async ({ user, url, token }, request) => {
        console.log(`[Auth] Password reset requested for ${user.email}`);
        return Promise.resolve();
      },
    },

    // Session settings
    session: {
      expiresIn: 60 * 60 * 24 * 30,  // 30 days
      updateAge: 60 * 60 * 24,        // renew every 24h
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,               // cache for 5 minutes
      },
    },

    // Rate limiting
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },

    // IP address from Cloudflare headers
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
  });
}
```

### 3.5 Route Mounting

In `apps/merchant/src/index.ts`:

```typescript
// Better Auth routes — handles signin, signup, session management via cookies
app.all('/api/auth/*', async (c) => {
  const auth = createAuthRouter(c.env as any);
  return auth.fetch(c.req.raw);
});

app.get('/api/auth/session', async (c) => {
  const sessionApp = createSessionRouter(c.env as any);
  return sessionApp.fetch(c.req.raw);
});
```

The `createAuthRouter` delegates all `/api/auth/*` requests to Better Auth's built-in handler, providing endpoints like:
- `POST /api/auth/signin/email` — Sign in with email/password
- `POST /api/auth/signup/email` — Register new account
- `POST /api/auth/signout` — Invalidate current session
- `GET /api/auth/session` — Check current session (used by frontend)

The `createSessionRouter` provides a JSON endpoint that maps Better Auth's user shape to the existing `AuthContext` interface for frontend compatibility.

---

## 4. API Key Authentication

### 4.1 Key Types

| Prefix | Role | Scope |
|--------|------|-------|
| `sk_*` | Admin | Full access to all admin routes (`/v1/*`) |
| `pk_*` | Public | Read-only storefront endpoints (products, categories, reviews) |

### 4.2 Generation

```typescript
export function generateApiKey(prefix: 'pk' | 'sk'): string {
  const bytes = new Uint8Array(24);  // 24 bytes = 48 hex chars
  crypto.getRandomValues(bytes);
  return `${prefix}_${key}`;
}
```

### 4.3 Storage & Verification

Keys are stored as SHA-256 hashes in the `api_keys` table:

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of raw key
  key_prefix TEXT NOT NULL,          -- Display prefix (sk_ or pk_)
  role TEXT NOT NULL CHECK (role IN ('public', 'admin'))
);
```

The middleware hashes the incoming token and performs a single indexed lookup. Keys are seeded at Durable Object startup from `MERCHANT_SK` and `MERCHANT_PK` environment variables.

---

## 5. OAuth Token Authentication

### 5.1 Token Format

OAuth tokens are 64-character hexadecimal strings (32 bytes of random data). The middleware identifies them by pattern:

```typescript
const isOAuthToken = token.length === 64 && /^[a-f0-9]+$/.test(token);
```

### 5.2 Storage

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,   -- SHA-256 of raw token
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL
);
```

### 5.3 Scope-Based Access

The `requireScope()` middleware checks OAuth tokens against required scopes:

```typescript
export function requireScope(...requiredScopes: string[]) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (auth.role === 'oauth') {
      const hasAllScopes = requiredScopes.every(
        (scope) => auth.oauthScopes?.includes(scope)
      );
      if (!hasAllScopes) {
        throw ApiError.forbidden(`Required scopes: ${requiredScopes.join(', ')}`);
      }
    }
    await next();
  });
}
```

---

## 6. Order View Tokens

Order view tokens allow customers to check order status without logging in. They are HMAC-HS256 JWTs signed with `ORDER_TOKEN_SECRET`.

### 6.1 Generation

In `apps/merchant/src/lib/order-token.ts`:

```typescript
export async function generateOrderViewToken(
  orderId: string,
  secret: string,
  opts: OrderViewTokenOptions = {}
): Promise<string> {
  const key = await getSecretKey(secret);  // SHA-256 of ORDER_TOKEN_SECRET
  const jwt = new SignJWT({ oid: orderId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(new Date())
    .setExpirationTime('30d');               // 30 days

  return jwt.sign(key);
}
```

### 6.2 Verification

```typescript
export async function verifyOrderViewToken(
  token: string,
  orderId: string,
  secret: string
): Promise<{ oid: string }> {
  const key = await getSecretKey(secret);
  const { payload } = await jwtVerify(token, key);

  // Cross-check: token must match the specific order ID
  if (payload.oid !== orderId) {
    throw new Error('Token does not match order ID');
  }

  return payload as { oid: string };
}
```

### 6.3 Usage

Order view tokens are included in order confirmation emails as tracking links:
- `GET /v1/orders/:number?token=<jwt>` — View order without login
- `POST /v1/reviews/guest` — Submit a review as a guest via token

---

## 7. Role-Based Access Control

### 7.1 Roles

| Role | Source | Routes | Middleware |
|------|--------|--------|------------|
| `admin` | Better Auth session or `sk_*` API key | All admin routes (`/v1/*`) | `authMiddleware` → `adminOnly` |
| `public` | `pk_*` API key | Read-only endpoints | None (or explicit public check) |
| `oauth` | 64-char hex token | Marketplace sync routes | `authMiddleware` + `requireScope()` |
| `customer` | Better Auth session | Customer portal (`/v1/me/*`, `/v1/downloads`) | `customerAuthMiddleware` |

### 7.2 Role Gate

Defined in `apps/merchant/src/middleware/auth.ts`. There is one admin gate; setup and migrations, mail and AI settings use it too:

```typescript
export const adminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.get('auth').role !== 'admin') throw ApiError.forbidden('Admin access required');
  await next();
});
```

OAuth routes use `requireScope(...scopes)`.

### 7.3 Customer Account Resolution

Customer routes never take a customer id or email from the request. They call `resolveCustomer(db, auth.userId)` from `apps/merchant/src/lib/customers.ts`, which:

1. refuses users whose email isn't confirmed (403);
2. finds the `customers` row by `auth_provider_id = userId`;
3. otherwise claims the row with the same email (case-insensitive), e.g. one created by a guest checkout, setting `auth_provider = 'better-auth'` and `auth_provider_id`; or creates a new row;
4. links earlier guest orders placed with that email (`orders.customer_id`);
5. recomputes the customer's stats from the orders table and returns the row.

The other helpers in the same file keep the account's totals right whatever path an order takes:

| Helper | Used by | Does |
|---|---|---|
| `recalcCustomerStats(db, customerId)` | everything below | `order_count`, `total_spent_cents` (orders in `paid`/`processing`/`shipped`/`delivered`/`partially_refunded`, minus their refunds) and `last_order_at`, computed from orders |
| `upsertCustomerByEmail(db, email, details)` | Stripe webhook, admin order create | find or create the customer for an email |
| `linkOrderToCustomer(db, orderId, details)` | SSLCommerz IPN, UCP checkout | attach an order to the customer for its email, then recalc |
| `refreshOrderCustomer(db, orderId)` | refunds, order status changes | recalc the order's customer |

### 7.4 Data Stored per Customer

Everything a customer sees in their account is in the database, so it is the same on every device:

| Data | Where | Endpoints |
|---|---|---|
| Profile, addresses | `customers`, `customer_addresses` | `/v1/me/profile`, `/v1/me/addresses` |
| Orders, money spent | `orders`, `refunds`, `customers` stats | `/v1/me/orders`, `/v1/me/profile` |
| Cart | `customer_carts` (migration 043) | `GET`/`PUT /v1/me/cart` |
| Wishlist | `customers.metadata.wishlist` | `/v1/me/wishlist` |
| Saved carts | `customers.metadata` | `/v1/me/saved-carts` |
| Preferences | customer record | `/v1/me/preferences` |

The storefront keeps only a **guest** cart in localStorage. On sign-in it merges the guest cart into the account cart and clears the local copy.

---

## 8. Frontend Integration

### 8.1 Provider Architecture

The client app (`apps/client`) uses a provider-based auth abstraction:

```
AuthenticationProvider (root)
 └── AuthProviderWrapper
       └── useLocalProvider() — Better Auth session cookies
             ├── checkSession() → GET /api/auth/session
             ├── login() → window.location.href = /login
             ├── logout() → POST /api/auth/signout
             └── getJson/postJson/etc. → fetch with credentials: "include"
```

### 8.2 Local Provider Implementation

In `apps/client/src/features/auth/providers/local-provider.tsx`:

```typescript
export const useLocalProvider = (): AuthProvider => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Check session on mount and after navigation
  const checkSession = useCallback(async () => {
    const resp = await fetch(`${apiBase}/api/auth/session`);
    const data = await resp.json();
    if (data.session) {
      setUser(data.session.user);
      setIsAuthenticated(true);
    } else {
      setUser(null);
      setIsAuthenticated(false);
    }
  }, []);

  // API helpers automatically include session cookies
  const getJson = async (url: string): Promise<any> => {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  };

  // ... postJson, putJson, patchJson, deleteJson, postForm ...
};
```

### 8.3 Auth Components

Exported from `@/authentication`:

- `AuthenticationGuard` (prop `component`) — sends signed-out visitors to `/login?returnTo=…`.
- `AdminGuard` — wraps `/admin`; only `user.is_admin` sessions (ADMIN_EMAILS) get in.
- `useAuth()` — `user`, `isAuthenticated`, `isLoading`, `isAdmin`, `signInEmail`, `signUpEmail`, `resendVerification`, `refreshSession`, `logout`, and the JSON helpers.
- `useSecuredApi()` — the JSON helpers plus `isAdmin`.
- `EmailNotVerifiedError` — thrown by `signInEmail` on 403 `EMAIL_NOT_VERIFIED`.

`EmailAuthForm` (`features/auth/components/email-auth-form.tsx`) is the sign-in / create-account form used by the `/login` page and `LoginModal`. After sign-up, or a sign-in refused for an unconfirmed email, it shows "check your email" with a resend button. `signUpEmail` and `signInEmail` pass `callbackURL = <store>/login?verified=1[&returnTo=…]`, so the confirmation link signs the user in and brings them back.

---

## 9. Data Model

### 9.1 Better Auth Tables (Migration 037)

```sql
-- apps/merchant/migrations/037-add-better-auth-tables.sql

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,        -- SHA-256 hash of raw session token
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires_at ON session(expires_at);

CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT, refresh_token TEXT, id_token TEXT,
  access_token_expires_at TEXT, refresh_token_expires_at TEXT,
  scope TEXT, password TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON account(user_id);
```

### 9.2 Cross-Reference with Customers Table

The `customers` table (pre-existing) is linked to the Better Auth `user` table via email:

| customers field | user field | Relationship |
|----------------|------------|-------------|
| `email` | `email` | Join key for account resolution |
| `auth_provider` | — | Set to `'better-auth'` after migration |
| `auth_provider_id` | `user.id` | Stores the Better Auth user ID |
| `metadata` | — | Stores theme, currency preferences (JSON) |

### 9.3 API Keys Table

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,    -- SHA-256 of raw key
  key_prefix TEXT NOT NULL,          -- 'sk_' or 'pk_'
  role TEXT NOT NULL CHECK (role IN ('public', 'admin'))
);
```

### 9.4 OAuth Tokens Table

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL,   -- SHA-256 of raw token
  refresh_token_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL
);
```
