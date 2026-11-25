/**
 * Profile pictures: the browser crops the chosen photo to a centred square,
 * scales it to at most 512px and re-encodes it (WebP, or JPEG where the
 * browser can't encode WebP) before uploading to POST /v1/me/avatar.
 *
 * Re-encoding keeps uploads small (the API takes up to 2 MB) so large phone
 * photos still work, honours the photo's EXIF rotation, and drops its
 * metadata (EXIF, including any GPS location) before it leaves the device.
 */

export const AVATAR_SIZE = 512;
/** Largest photo accepted for resizing; the upload itself is far smaller. */
export const AVATAR_SOURCE_MAX_BYTES = 15 * 1024 * 1024;

export type AvatarError = "type" | "size" | "read";

/** The centred square to cut from a w×h image. */
export function squareCrop(w: number, h: number) {
  const side = Math.min(w, h);

  return { sx: (w - side) / 2, sy: (h - side) / 2, side };
}

/** Rejects files before any decoding: not an image, or too large. */
export function checkAvatarFile(file: {
  type: string;
  size: number;
}): AvatarError | null {
  if (!file.type.startsWith("image/")) return "type";
  if (file.size > AVATAR_SOURCE_MAX_BYTES) return "size";

  return null;
}

/** Crops, scales and re-encodes the photo. Throws "read" if it can't be decoded. */
export async function prepareAvatar(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("read");
  }
  const { sx, sy, side } = squareCrop(bitmap.width, bitmap.height);
  const out = Math.min(AVATAR_SIZE, side);
  const canvas = document.createElement("canvas");

  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");

  if (!ctx) throw new Error("read");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, out, out);
  bitmap.close();

  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
  // Some browsers silently fall back to PNG for unsupported types.
  let blob = await encode("image/webp");

  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg");
  if (!blob) throw new Error("read");

  return blob;
}

/** "Ada Lovelace" → "AL"; falls back to the email's first letter. */
export function initialsOf(name?: string | null, email?: string | null) {
  const fromName = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  return fromName || (email ?? "").trim().charAt(0).toUpperCase() || "?";
}
