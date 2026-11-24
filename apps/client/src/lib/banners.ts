/**
 * Home-page banners (Admin → Banners, backend routes/banners.ts).
 * Text fields are plain text or per-locale JSON, resolved with resolveTitle.
 */
import { useQuery } from "@tanstack/react-query";

import { getApiBase } from "@/lib/api-base";

export interface Banner {
  id: string;
  title: string;
  description: string;
  image_url: string | null;
  image_alt: string;
  cta_primary_label: string | null;
  cta_primary_href: string | null;
  cta_secondary_label: string | null;
  cta_secondary_href: string | null;
  sort_order: number;
  status: "active" | "draft";
  created_at: string;
  updated_at: string;
}

export type BannerInput = Omit<Banner, "id" | "created_at" | "updated_at">;

export const EMPTY_BANNER: BannerInput = {
  title: "",
  description: "",
  image_url: null,
  image_alt: "",
  cta_primary_label: null,
  cta_primary_href: null,
  cta_secondary_label: null,
  cta_secondary_href: null,
  sort_order: 0,
  status: "draft",
};

/** The banner the home page shows: the first active one, or null for the built-in hero. */
export function useActiveBanner() {
  return useQuery({
    queryKey: ["banners", "active"],
    queryFn: async (): Promise<Banner | null> => {
      const res = await fetch(`${getApiBase()}/v1/banners`);

      if (!res.ok) return null; // fall back to the built-in hero

      const body = (await res.json()) as { items?: Banner[] };

      return body.items?.[0] ?? null;
    },
    staleTime: 60_000,
  });
}

/** Same rule as the backend (lib/storefront-settings.ts isSafeLink). */
export function isSafeLink(href: string): boolean {
  if (href.startsWith("/"))
    return !href.startsWith("//") && !href.startsWith("/\\");
  try {
    const u = new URL(href);

    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Key of an image stored in our R2 bucket (…/v1/images/<key>), else null. */
export function storedImageKey(url: string | null): string | null {
  if (!url) return null;
  const m = /\/v1\/images\/([A-Za-z0-9._-]+)$/.exec(url);

  return m ? m[1] : null;
}
