/**
 * Small square product photo for admin lists, with a placeholder icon when
 * there is no photo or it fails to load. Decorative (alt=""): the product
 * name sits right next to it.
 */
import { useState } from "react";
import { ImageOff } from "lucide-react";

interface ThumbSource {
  image_url?: string | null;
  variants?: { thumbnail_url?: string | null; image_url?: string | null }[];
}

/** Cover photo, else the first variant's thumbnail or photo (as the storefront card). */
export function productThumbUrl(p: ThumbSource): string | null {
  const v = p.variants?.[0];

  return p.image_url || v?.thumbnail_url || v?.image_url || null;
}

export function ProductThumb({
  src,
  className = "h-12 w-12",
}: {
  src: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const frame = `${className} shrink-0 overflow-hidden rounded-md border border-bx-line bg-bx-indigo-tint`;

  if (!src || failed) {
    return (
      <span aria-hidden="true" className={`${frame} grid place-items-center`}>
        <ImageOff className="h-5 w-5 text-bx-stone" />
      </span>
    );
  }

  return (
    <img
      alt=""
      className={`${frame} object-cover`}
      decoding="async"
      loading="lazy"
      src={src}
      onError={() => setFailed(true)}
    />
  );
}
