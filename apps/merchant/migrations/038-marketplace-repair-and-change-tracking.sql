-- Migration 038: marketplace repair + change tracking
-- Reference copy of the inline 038_* migrations in src/do.ts.
--
-- Inline, each block below is its own migration step, because the runner
-- marks a step as applied even when its SQL throws. tests/schema-038.test.ts
-- asserts the end state.
--
-- SQLite can't ADD COLUMN with a non-constant default, so updated_at is added
-- nullable, backfilled from created_at, and kept current by triggers.

-- ── products / variants / orders: updated_at ───────────────────────────────

ALTER TABLE products ADD COLUMN updated_at TEXT;
UPDATE products SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at);

CREATE TRIGGER IF NOT EXISTS trg_products_updated_at_insert
AFTER INSERT ON products FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE products SET updated_at = COALESCE(NEW.created_at, datetime('now')) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_products_updated_at_update
AFTER UPDATE ON products FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE products SET updated_at = datetime('now') WHERE id = NEW.id;
END;

ALTER TABLE variants ADD COLUMN updated_at TEXT;
UPDATE variants SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_variants_updated_at ON variants(updated_at);

CREATE TRIGGER IF NOT EXISTS trg_variants_updated_at_insert
AFTER INSERT ON variants FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE variants SET updated_at = COALESCE(NEW.created_at, datetime('now')) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_variants_updated_at_update
AFTER UPDATE ON variants FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE variants SET updated_at = datetime('now') WHERE id = NEW.id;
END;

ALTER TABLE orders ADD COLUMN updated_at TEXT;
UPDATE orders SET updated_at = created_at WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders(updated_at);

CREATE TRIGGER IF NOT EXISTS trg_orders_updated_at_insert
AFTER INSERT ON orders FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE orders SET updated_at = COALESCE(NEW.created_at, datetime('now')) WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_orders_updated_at_update
AFTER UPDATE ON orders FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN
  UPDATE orders SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ── orders.channel_id (NULL = web store order) ─────────────────────────────

ALTER TABLE orders ADD COLUMN channel_id TEXT REFERENCES marketplace_channels(id);
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel_id);

-- ── marketplace_credentials.expires_at (was buried in metadata JSON) ───────

ALTER TABLE marketplace_credentials ADD COLUMN expires_at TEXT;
UPDATE marketplace_credentials
  SET expires_at = json_extract(metadata, '$.expires_at')
  WHERE expires_at IS NULL AND json_valid(metadata);

-- ── marketplace_orders: one row per external order ─────────────────────────
-- SQLite can't add a table constraint after the fact; a unique index does the same.

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_orders_channel_external
  ON marketplace_orders(channel_id, external_order_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_orders_internal
  ON marketplace_orders(internal_order_id);

-- ── One row per OAuth connect attempt; consumed (deleted) by the callback ──

CREATE TABLE IF NOT EXISTS marketplace_oauth_states (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'amazon')),
  channel_id TEXT REFERENCES marketplace_channels(id) ON DELETE CASCADE,
  code_verifier TEXT,
  return_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_oauth_states_expires
  ON marketplace_oauth_states(expires_at);

-- ── Marketplace line items ↔ order_items (shipments are confirmed per line) ─

CREATE TABLE IF NOT EXISTS marketplace_order_lines (
  id TEXT PRIMARY KEY,
  marketplace_order_id TEXT NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
  external_line_item_id TEXT NOT NULL,
  order_item_id TEXT REFERENCES order_items(id),
  sku TEXT,
  qty INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (marketplace_order_id, external_line_item_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_order_item
  ON marketplace_order_lines(order_item_id);

-- ── De-duplicates inbound marketplace notifications ────────────────────────

CREATE TABLE IF NOT EXISTS marketplace_webhook_events (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('etsy', 'ebay', 'amazon')),
  channel_id TEXT REFERENCES marketplace_channels(id) ON DELETE SET NULL,
  external_event_id TEXT NOT NULL,
  topic TEXT,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  error TEXT,
  UNIQUE (platform, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_webhook_events_unprocessed
  ON marketplace_webhook_events(processed_at, received_at);
