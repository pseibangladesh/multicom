-- Migration 038: Rename auth0_user_id → user_id in saved_carts table
--
-- The saved_carts table was created with column 'auth0_user_id' (migration 026)
-- which referenced the Auth0 JWT 'sub' claim. Since we've migrated to Better Auth,
-- all user identifiers now use standard 'user_id' naming. This migration renames
-- the column and updates the unique constraint + index accordingly.
--
-- D1/SQLite does not support ALTER TABLE ... RENAME COLUMN, so we recreate the table.
-- On fresh databases (where embedded schema already uses 'user_id'), this migration
-- is a safe no-op — the error handler marks it as applied without modifying data.

-- Step 1: Create new table with correct column name
CREATE TABLE IF NOT EXISTS saved_carts_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  cart_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, cart_id),
  FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE
);

-- Step 2: Copy existing data (auth0_user_id → user_id)
INSERT OR IGNORE INTO saved_carts_new (id, user_id, cart_id, created_at, updated_at)
SELECT id, auth0_user_id, cart_id, created_at, updated_at FROM saved_carts;

-- Step 3: Drop old table and rename new one
DROP TABLE IF EXISTS saved_carts;
ALTER TABLE saved_carts_new RENAME TO saved_carts;

-- Step 4: Recreate index with correct column name
CREATE INDEX IF NOT EXISTS idx_saved_carts_user ON saved_carts(user_id);
