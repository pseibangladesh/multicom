-- Buy now, page builder and showcase sections.
-- Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md

-- 'buy_now': created by the Buy now page (one item, never the shopper's cart).
ALTER TABLE carts ADD COLUMN source TEXT NOT NULL DEFAULT 'cart' CHECK (source IN ('cart', 'buy_now'));

-- 'showcase': only used by page-builder sections, never shown to shoppers as a category.
ALTER TABLE categories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'listed' CHECK (visibility IN ('listed', 'showcase'));

-- Home page sections, in order (Admin → Page builder).
CREATE TABLE IF NOT EXISTS home_sections (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('banner', 'catalogue', 'showcase')),
  title         TEXT,
  category_id   TEXT REFERENCES categories(id) ON DELETE CASCADE,
  product_limit INTEGER NOT NULL DEFAULT 12,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_home_sections_status_sort ON home_sections (status, sort_order);

-- Built-in sections: the page looks as before until the admin changes it.
INSERT OR IGNORE INTO home_sections (id, type, sort_order, status) VALUES
  ('builtin-banner', 'banner', 0, 'active'),
  ('builtin-catalogue', 'catalogue', 100, 'active');
