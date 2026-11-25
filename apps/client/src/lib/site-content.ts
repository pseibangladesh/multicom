/**
 * Site content managed from the admin (backend: apps/merchant/src/lib/site-content.ts):
 * the footer's social links and edits to the informational pages.
 *
 * Page edits are saved per locale. A locale with no saved edit keeps the
 * built-in text from config/cms-content.ts, so an admin can change the
 * English About page without wiping its other translations.
 */
import { useQuery } from "@tanstack/react-query";

import { getApiBase } from "@/lib/api-base";
import {
  CMS_CONTENT,
  pickCmsLocale,
  type CmsPageContent,
} from "@/config/cms-content";
import { SOCIAL_LINKS } from "@/config/navigation";

export interface SocialLink {
  platform: string;
  url: string;
}

/** Same list and order as SOCIAL_PLATFORMS on the backend. */
export const SOCIAL_PLATFORMS = [
  "github",
  "facebook",
  "instagram",
  "x",
  "linkedin",
  "youtube",
  "tiktok",
  "whatsapp",
  "telegram",
  "pinterest",
  "discord",
  "threads",
  "website",
] as const;

export type CmsPageEdits = Record<string, CmsPageContent>;

export const socialLinksQueryKey = ["storefront-settings", "social-links"];
export const cmsPageQueryKey = (handle: string) => [
  "storefront-settings",
  "cms-page",
  handle,
];

/** Footer links when the backend can't be reached: the project's own accounts. */
const FALLBACK_SOCIAL: SocialLink[] = SOCIAL_LINKS.map((l) => ({
  platform: l.key,
  url: l.href,
}));

/** Same rule as the backend: an absolute http(s) URL. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());

    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
  } catch {
    return false;
  }
}

export async function fetchSocialLinks(): Promise<SocialLink[]> {
  const res = await fetch(`${getApiBase()}/v1/storefront/social-links`);

  if (!res.ok) throw new Error(`social links: HTTP ${res.status}`);

  return ((await res.json()) as { links: SocialLink[] }).links;
}

export function useSocialLinks() {
  return useQuery({
    queryKey: socialLinksQueryKey,
    queryFn: async () => {
      try {
        return await fetchSocialLinks();
      } catch {
        return FALLBACK_SOCIAL; // decoration only: never break the footer
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export async function fetchCmsPageEdits(handle: string): Promise<CmsPageEdits> {
  const res = await fetch(
    `${getApiBase()}/v1/storefront/pages/${encodeURIComponent(handle)}`,
  );

  if (!res.ok) throw new Error(`page ${handle}: HTTP ${res.status}`);

  return ((await res.json()) as { content: CmsPageEdits }).content;
}

/** Built-in text with the saved edits laid over it, locale by locale. */
export function mergeCmsPage(
  handle: string,
  edits: CmsPageEdits | undefined,
): Record<string, CmsPageContent> | null {
  const builtIn = CMS_CONTENT[handle];

  if (!builtIn) return null;

  return { ...builtIn, ...(edits ?? {}) };
}

/**
 * The page for a handle in the visitor's language. Shows the built-in text
 * straight away and swaps in saved edits once they load; if the backend is
 * down the built-in text stays.
 */
export function useCmsPage(handle: string, locale: string) {
  const known = Object.prototype.hasOwnProperty.call(CMS_CONTENT, handle);
  const { data, isPending } = useQuery({
    queryKey: cmsPageQueryKey(handle),
    queryFn: () => fetchCmsPageEdits(handle),
    enabled: known,
    staleTime: 60_000,
    retry: 1,
  });
  const merged = known ? mergeCmsPage(handle, data) : null;

  return {
    page: merged ? pickCmsLocale(merged, locale) : null,
    isLoadingEdits: known && isPending,
  };
}
