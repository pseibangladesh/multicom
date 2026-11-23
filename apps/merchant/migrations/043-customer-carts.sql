-- A signed-in customer's shopping cart, stored per account so it follows them
-- to any device or browser. Signed-out (guest) carts stay in the browser.
CREATE TABLE IF NOT EXISTS customer_carts (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  items       TEXT NOT NULL DEFAULT '[]',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
