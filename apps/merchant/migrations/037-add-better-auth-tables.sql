-- Migration 037: Add Better Auth tables (users, sessions, accounts)
-- These tables replace the Auth0-dependent customer auth flow.
--
-- The 'users' table mirrors the existing 'customers' table schema but uses
-- Better Auth column names (email, emailVerified, name, image, createdAt, updatedAt).
-- The 'sessions' table stores hashed session tokens for cookie-based auth.
-- The 'accounts' table links social login providers to users.
--
-- Run locally:  npx wrangler d1 execute merchant --local --file migrations/037-add-better-auth-tables.sql
-- Run remotely: npx wrangler d1 execute merchant-db --remote --file migrations/037-add-better-auth-tables.sql

-- ============================================================
-- USERS TABLE (Better Auth)
-- Mirrors customers table but uses Better Auth naming conventions.
-- 'id' maps to customers.id for cross-reference during migration.
-- ============================================================
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SESSIONS TABLE (Better Auth)
-- Stores session tokens hashed via SHA-256.
-- token column stores the hashed value; raw token is in the cookie.
-- expires_at must be indexed for fast expiry checks.
-- ============================================================
CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires_at ON session(expires_at);

-- ============================================================
-- ACCOUNTS TABLE (Better Auth)
-- Links social auth providers to users. Not used in initial phase
-- but included for future-proofing (Google, GitHub, etc.).
-- ============================================================
CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON account(user_id);
