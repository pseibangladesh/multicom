-- Migration 037 (marketplace): multi-channel marketplace tables (Etsy, eBay, Amazon)
-- Reference copy of the inline migrations 037_marketplace_channels,
-- 037_marketplace_product_mappings, 037_marketplace_orders,
-- 037_marketplace_credentials and 037_marketplace_sync_jobs in src/do.ts.
--
-- Shares the 037 number with 037-add-better-auth-tables.sql: the inline
-- migration names were already deployed, so they are not renumbered.
-- Like every file in this folder it is documentation; MerchantDO runs the
-- inline copy in ensureInitialized().

CREATE TABLE IF NOT EXISTS marketplace_channels (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'amazon')),
  store_id TEXT NOT NULL,
  external_shop_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
       CHECK (status IN ('active', 'paused', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_channels_platform ON marketplace_channels(platform);
CREATE INDEX IF NOT EXISTS idx_marketplace_channels_store ON marketplace_channels(store_id);

CREATE TABLE IF NOT EXISTS marketplace_product_mappings (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  variant_id TEXT REFERENCES variants(id),
  external_listing_id TEXT NOT NULL,
  external_sku TEXT,
  status TEXT NOT NULL DEFAULT 'active'
       CHECK (status IN ('active', 'inactive', 'error')),
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, external_listing_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_product_mappings_channel ON marketplace_product_mappings(channel_id);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  internal_order_id TEXT REFERENCES orders(id),
  external_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_channel ON marketplace_orders(channel_id);

CREATE TABLE IF NOT EXISTS marketplace_credentials (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  credential_type TEXT NOT NULL
    CHECK (credential_type IN ('api_key', 'oauth_token', 'refresh_token')),
  encrypted_value TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, credential_type)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_credentials_channel ON marketplace_credentials(channel_id);

CREATE TABLE IF NOT EXISTS marketplace_sync_jobs (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES marketplace_channels(id),
  job_type TEXT NOT NULL
    CHECK (job_type IN ('push_products', 'push_inventory', 'pull_orders', 'sync_all')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  payload TEXT DEFAULT '{}',
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_sync_jobs_channel_status ON marketplace_sync_jobs(channel_id, status);
