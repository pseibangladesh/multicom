/**
 * Customer profile pictures (POST/DELETE /v1/me/avatar).
 *
 * The file goes to the IMAGES bucket under an `avatar-<uuid>` key, and its
 * URL is stored in Better Auth's `user.image`, so the session, the profile and
 * the header all show the same picture.
 *
 * The type is read from the file's first bytes, never from the browser's
 * Content-Type, so an SVG or HTML file renamed to .png is refused (it would be
 * served back from our own origin).
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_KEY_PREFIX = 'avatar-';

export type AvatarType = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/** JPEG, PNG or WebP by magic number; anything else is null. */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * The bucket key of an avatar this endpoint stored, or null for anything else
 * (an external picture, a product image). Only those keys are ever deleted.
 */
export function ownedAvatarKey(imageUrl: string | null | undefined, imagesBaseUrl: string): string | null {
  if (!imageUrl) return null;
  const prefix = `${imagesBaseUrl.replace(/\/+$/, '')}/`;
  if (!imageUrl.startsWith(prefix)) return null;
  const key = imageUrl.slice(prefix.length);
  return /^avatar-[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key) ? key : null;
}
