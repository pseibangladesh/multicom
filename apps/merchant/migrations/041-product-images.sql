-- Product image gallery: JSON array of {"url", "alt"} in display order.
-- The first image is the cover; products.image_url mirrors its URL.
ALTER TABLE products ADD COLUMN images TEXT;
