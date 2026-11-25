/**
 * Site content managed from the admin: the footer's social links and edits to
 * the storefront's informational pages (About, Blog, FAQ, policies...).
 *
 * Both live in the `config` key/value table as JSON, so no schema change:
 *   storefront.social_links   → SocialLink[] (footer order)
 *   cms.page.<handle>         → { [locale]: CmsPageContent }
 *
 * A page with nothing saved for a locale keeps the client's built-in text
 * (apps/client/src/config/cms-content.ts).
 */
import type { Database } from '../db';
import { readConfig, writeConfig, SUPPORTED_LANGUAGES, type LanguageCode } from './storefront-settings';

/** Platforms the footer has an icon for (apps/client/src/shared/ui/social-icons.tsx). */
export const SOCIAL_PLATFORMS = [
  'github',
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'youtube',
  'tiktok',
  'whatsapp',
  'telegram',
  'pinterest',
  'discord',
  'threads',
  'website',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export interface SocialLink {
  platform: SocialPlatform;
  url: string;
}

export const MAX_SOCIAL_LINKS = 20;

/** Shown until an admin saves a list (an empty saved list means "no links"). */
export const DEFAULT_SOCIAL_LINKS: SocialLink[] = [
  { platform: 'github', url: 'https://github.com/pseibangladesh/multicom' },
];

/** Pages the storefront has (the keys of CMS_CONTENT in the client). */
export const CMS_PAGE_HANDLES = [
  'about',
  'blog',
  'careers',
  'press',
  'contact',
  'faq',
  'shipping-policy',
  'returns-policy',
  'privacy-policy',
  'terms-of-service',
  'cookie-policy',
  'legal-mentions',
] as const;
export type CmsPageHandle = (typeof CMS_PAGE_HANDLES)[number];

export interface CmsSection {
  heading: string;
  body: string;
}

export interface CmsPageContent {
  title: string;
  lead: string;
  sections: CmsSection[];
}

export type CmsPageOverrides = Partial<Record<LanguageCode, CmsPageContent>>;

const SOCIAL_KEY = 'storefront.social_links';
const pageKey = (handle: CmsPageHandle) => `cms.page.${handle}`;

/** Only absolute http(s) URLs: footer links open in a new tab, off-site. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export const isCmsPageHandle = (h: string): h is CmsPageHandle =>
  (CMS_PAGE_HANDLES as readonly string[]).includes(h);

const isPlatform = (p: unknown): p is SocialPlatform =>
  typeof p === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(p);

export async function getSocialLinks(db: Database): Promise<SocialLink[]> {
  const saved = await readConfig<unknown>(db, SOCIAL_KEY);
  if (!Array.isArray(saved)) return DEFAULT_SOCIAL_LINKS.map((l) => ({ ...l }));
  // Drop anything a later version no longer understands rather than failing.
  return saved
    .filter(
      (l): l is SocialLink =>
        typeof l === 'object' && l !== null && isPlatform(l.platform) && typeof l.url === 'string' && isSafeExternalUrl(l.url),
    )
    .map((l) => ({ platform: l.platform, url: l.url }));
}

export async function saveSocialLinks(db: Database, links: SocialLink[]): Promise<SocialLink[]> {
  await writeConfig(
    db,
    SOCIAL_KEY,
    links.map((l) => ({ platform: l.platform, url: l.url.trim() })),
  );
  return getSocialLinks(db);
}

const isLocale = (l: string): l is LanguageCode => (SUPPORTED_LANGUAGES as readonly string[]).includes(l);

/** Saved edits for a page, by locale (empty when the page was never edited). */
export async function getCmsPageOverrides(db: Database, handle: CmsPageHandle): Promise<CmsPageOverrides> {
  const saved = await readConfig<Record<string, CmsPageContent>>(db, pageKey(handle));
  if (!saved || typeof saved !== 'object') return {};
  const out: CmsPageOverrides = {};
  for (const [locale, content] of Object.entries(saved)) {
    if (isLocale(locale) && content && typeof content.title === 'string') out[locale] = content;
  }
  return out;
}

/** Replaces the page's saved edits. An empty object restores the built-in text everywhere. */
export async function saveCmsPageOverrides(
  db: Database,
  handle: CmsPageHandle,
  content: CmsPageOverrides,
): Promise<CmsPageOverrides> {
  if (Object.keys(content).length === 0) {
    await db.run(`DELETE FROM config WHERE key = ?`, [pageKey(handle)]);
    return {};
  }
  await writeConfig(db, pageKey(handle), content);
  return getCmsPageOverrides(db, handle);
}

/** Handles that have saved edits, with the locales edited. */
export async function listEditedCmsPages(db: Database): Promise<Record<string, LanguageCode[]>> {
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM config WHERE key LIKE 'cms.page.%'`,
  );
  const out: Record<string, LanguageCode[]> = {};
  for (const r of rows) {
    const handle = r.key.slice('cms.page.'.length);
    if (!isCmsPageHandle(handle)) continue;
    try {
      out[handle] = Object.keys(JSON.parse(r.value) as object).filter(isLocale);
    } catch {
      /* unreadable row: treat as not edited */
    }
  }
  return out;
}
