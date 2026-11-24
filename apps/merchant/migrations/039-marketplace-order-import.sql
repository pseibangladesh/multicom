-- Migration 039: marketplace order import + shipment push
-- Reference copy of the inline 039_* migrations in src/do.ts.

-- Carrier code for the tracking number (e.g. USPS, UPS). When set it
-- overrides the channel's default_carrier when confirming shipment.
ALTER TABLE orders ADD COLUMN tracking_carrier TEXT;

-- Units actually taken from stock for this line at import (can be less than
-- qty when the marketplace oversold).
ALTER TABLE marketplace_order_lines ADD COLUMN inventory_deducted INTEGER NOT NULL DEFAULT 0;
