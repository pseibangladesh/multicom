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
10. [Migration from Auth0](#10-migration-from-auth0)

---

## 1. Overview

Multicom uses a **multi-layer authentication system** that supports three distinct methods:

| Layer | Method | Token Format | Use Case |
|-------|--------|-------------|----------|
| 1 | Better Auth session cookie | `better-auth.session_token=***` (HttpOnly) | Admin dashboard + customer portal |
| 2 | API keys | `sk_*` (admin) / `pk_*` (public) | Server-to-server integrations |
| 3 | OAuth tokens | 64-character hex string | Third-party marketplace integrations |

All methods are handled by middleware in the Cloudflare Worker, checked in priority order. **Better Auth replaces the previous Auth0 JWT flow** — customers now sign up/log in with email/password directly on the platform rather than through an external identity provider.

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

### 3.1 Sign Up / Sign In Flow

```
Customer                              Backend Worker                  D1 Database
   │                                    │                              │
   │  POST /api/auth/signup/email       │                              │
   │  { email, password }               │                              │
   │──► createAuthRouter()             │                              │
   │        │                           │                              │
   │        ▼                          │                              │
   │   betterAuth.handler()            │                              │
   │        │                           │                              │
   │        ├──► Validate email format  │                              │
   │        ├──► Hash password (bcrypt) │                              │
   │        ├──► INSERT INTO "user"    │◄────────────────── Creates user
   │        │                            │                              │
   │        ├──► Create session          │                              │
   │        │   INSERT INTO "session"   │◄────────────────── Stores hash
   │        │                            │                              │
   │        └──► Set HttpOnly cookie     │                              │
   │              better-auth.session_token=*** (raw)                │
   │                                    │                              │
```

The same flow applies to sign-in (`POST /api/auth/signin/email`), except the password is verified against the stored hash instead of creating a new user.

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

For customer-facing routes (`/v1/me/*`), a separate `customerAuthMiddleware` in the same file handles session verification with role `customer`:

```typescript
// apps/merchant/src/middleware/auth.ts (lines 227-266)
export const customerAuthMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const sessionCookie = c.req.header('cookie') || '';
  const sessionMatch = sessionCookie.match(/better-auth\.session_token=([^;]+)/);

  if (sessionMatch) {
    // ... same hash + DB lookup as above ...
    if (sessionResult.length > 0) {
      c.set('auth', {
        role: 'customer',
        email: row.email,
        name: row.name,
        userId: row.user_id,
        stripeSecretKey: null,
        stripeWebhookSecret: null,
      });
    }
  }

  throw ApiError.unauthorized('Missing or invalid session');
});
```

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

### 7.2 Role-Gate Middlewares

Defined in `apps/merchant/src/middleware/auth.ts`:

```typescript
export const adminOnly = createMiddleware<HonoEnv>(async (c, next) => {
  const auth = c.get('auth');
  if (Array.isArray(auth.role)) {
    if (!auth.role.includes('admin')) throw ApiError.forbidden(...);
  } else if (auth.role !== 'admin') {
    throw ApiError.forbidden(...);
  }
  await next();
});

export const aiAccessOnly = createMiddleware<HonoEnv>(async (c, next) => {
  // Checks for 'aiadmin' role
});

export const mailAccessOnly = createMiddleware<HonoEnv>(async (c, next) => {
  // Checks for 'mail' role
});
```

### 7.3 Customer Account Resolution

When a Better Auth session is verified, the middleware sets `auth.userId` (the `user.id`). Customer-facing routes resolve the corresponding `customers` row:

```typescript
// apps/merchant/src/routes/me.ts — resolveCustomer()
async function resolveCustomer(db: any, userId: string) {
  // Find customer by email match with Better Auth user
  const customerResult = await db.query<any>(
    `SELECT * FROM customers WHERE email IN (SELECT email FROM "user" WHERE id = ?) LIMIT 1`,
    [userId]
  );

  if (customerResult.length > 0) return customerResult[0];

  // Auto-provision: create customer row on first session login
  const userResult = await db.query<any>(
    `SELECT email, name FROM "user" WHERE id = ? LIMIT 1`,
    [userId]
  );

  if (userResult.length > 0) {
    const customerId = uuid();
    await db.run(
      `INSERT INTO customers (id, email, auth_provider, auth_provider_id, ...)
       VALUES (?, ?, 'better-auth', ?, ..., ?, ?)`,
      [customerId, userRow.email.toLowerCase(), userId, ...]
    );
    return (await db.query(`SELECT * FROM customers WHERE id = ?`, [customerId]))[0];
  }

  throw ApiError.unauthorized('User not found in Better Auth');
}
```

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

The auth components (`LoginButton`, `LogoutButton`, `AuthenticationGuard`, etc.) in `apps/client/src/features/auth/components/auth-components.tsx` wrap the provider hooks:

```typescript
export function AuthenticationGuard({ children, fallback }) {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Loading />;
  if (!isAuthenticated) return fallback ?? <LoginModal />;
  return children;
}
```

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

---

## 10. Migration from Auth0

### 10.1 Migration Script

The script `apps/merchant/scripts/migrate-auth0-to-better-auth.ts` maps existing Auth0 customers to Better Auth users:

```bash
npx tsx scripts/migrate-auth0-to-better-auth.ts
npx tsx scripts/migrate-auth0-to-better-auth.ts --dry  # preview only
```

### 10.2 Migration Steps

1. **Run migration 037** — Creates `user`, `session`, and `account` tables in D1.
2. **Run the migration script** — For each customer with `auth_provider IS NOT NULL`:
   - Inserts a row into `"user"` preserving email, name, locale, and metadata.
   - If the customer was Auth0-linked (`auth_provider = 'auth0'`), creates a session with a random token (hashed) valid for 30 days.
   - Updates `customers.auth_provider = 'better-auth'`.
3. **Deploy updated worker** — The new auth middleware reads from the Better Auth tables instead of verifying Auth0 JWTs.

### 10.3 What Changed

| Before (Auth0) | After (Better Auth) |
|-----------------|---------------------|
| External identity provider (Auth0 tenant) | Built-in email/password on platform |
| JWT tokens with JWKS verification | Session cookies with DB hash lookup |
| `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` env vars | `BETTER_AUTH_SECRET`, `API_BASE_URL` |
| Auth0 hosted login page | Platform sign-in at `/api/auth/signin/email` |
| Admin permissions via Auth0 scopes | Role-based access (`admin`, `customer`) |
| Management API proxy routes | Removed (no external IAM) |

### 10.4 What Stayed the Same

- **API keys** (`sk_*` / `pk_*`) — unchanged, still verified by SHA-256 hash lookup
- **OAuth tokens** (64-char hex) — unchanged, still scoped for marketplace integrations
- **Order view tokens** — unchanged, still HMAC-HS256 JWTs signed with `ORDER_TOKEN_SECRET`
- **Customer data schema** — the `customers` table is preserved; Better Auth adds a parallel `user` table
