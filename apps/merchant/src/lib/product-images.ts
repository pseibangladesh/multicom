/**
 * Product image gallery.
 *
 * Stored as a JSON array in products.images, in display order; the first image
 * is the cover. products.image_url is kept equal to the cover's URL so code
 * that only knows about one image (feeds, cards, older clients) keeps working.
 * Products saved before the gallery existed may have image_url but no images:
 * they read back as a one-image gallery.
 */
import { z } from '@hono/zod-openapi';

export const MAX_PRODUCT_IMAGES = 20;

const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Image URL must start with http:// or https://' });

export const ProductImageSchema = z
  .object({
    url: httpUrl.openapi({ example: 'https://example.com/v1/images/abc.webp' }),
    alt: z
      .string()
      .max(1000)
      .default('')
      .openapi({ example: '{"en-US":"Front view","fr-FR":"Vue de face"}', description: 'Image description for screen readers: plain text or JSON with locale keys' }),
  })
  .openapi('ProductImage');

export type ProductImage = { url: string; alt: string };

/** Read the stored gallery, tolerating bad data and pre-gallery rows. */
export function parseProductImages(images: unknown, imageUrl: unknown): ProductImage[] {
  if (typeof images === 'string' && images) {
    try {
      const parsed: unknown = JSON.parse(images);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((i): i is { url: string; alt?: unknown } =>
            !!i && typeof i === 'object' && typeof (i as { url?: unknown }).url === 'string')
          .map((i) => ({ url: i.url, alt: typeof i.alt === 'string' ? i.alt : '' }));
      }
    } catch {
      // fall through to image_url
    }
  }
  return typeof imageUrl === 'string' && imageUrl ? [{ url: imageUrl, alt: '' }] : [];
}

/** Columns to write for a new gallery: [images JSON, cover URL]. */
export function serializeProductImages(images: ProductImage[]): [string, string | null] {
  const clean = images.map((i) => ({ url: i.url, alt: i.alt ?? '' }));
  return [JSON.stringify(clean), clean[0]?.url ?? null];
}
