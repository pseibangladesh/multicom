-- Migration 036: SSLCommerz payment gateway support
-- Adds tracking columns to orders and a config entry for gateway settings.

ALTER TABLE orders ADD COLUMN sslcommerz_tran_id TEXT;
ALTER TABLE orders ADD COLUMN payment_gateway TEXT DEFAULT 'stripe';

CREATE INDEX IF NOT EXISTS idx_orders_sslcommerz_tran ON orders(sslcommerz_tran_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_gateway ON orders(payment_gateway);
