-- Migration 040: admin modules
-- Reference copy of the inline 040_* migrations in src/do.ts.

-- Home-page banners managed from Admin → Banners. title/description are
-- plain text or per-locale JSON ({"en-US": "...", "bn-BD": "..."}).
CREATE TABLE IF NOT EXISTS banners (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  image_alt TEXT NOT NULL DEFAULT '',
  cta_primary_label TEXT,
  cta_primary_href TEXT,
  cta_secondary_label TEXT,
  cta_secondary_href TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'draft')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_banners_status_sort ON banners (status, sort_order);

-- Variant options and a merchant availability override.
-- in_stock: sold as before (limited by inventory); out_of_stock: cart and
-- UCP refuse it; preorder: labelled "Pre-order", still limited by inventory.
ALTER TABLE variants ADD COLUMN color TEXT;
ALTER TABLE variants ADD COLUMN size TEXT;
ALTER TABLE variants ADD COLUMN availability TEXT NOT NULL DEFAULT 'in_stock'
  CHECK (availability IN ('in_stock', 'out_of_stock', 'preorder'));

-- Optional label for API keys created from Admin → API keys.
ALTER TABLE api_keys ADD COLUMN name TEXT;
