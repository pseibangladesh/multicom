/**
 * Storefront settings managed from the admin (languages, UCP switch) and the
 * shared rules behind banners and variant availability.
 *
 * Settings live in the `config` key/value table as JSON.
 */
import type { Database } from '../db';

/** Locales the client ships translation files for (apps/client/src/lib/languages.ts). */
export const SUPPORTED_LANGUAGES = ['en-US', 'fr-FR', 'es-ES', 'zh-CN', 'ar-SA', 'he-IL', 'bn-BD'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export interface LanguageSettings {
  enabled: LanguageCode[];
  default: LanguageCode;
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  enabled: [...SUPPORTED_LANGUAGES],
  default: 'en-US',
};

const LANGUAGES_KEY = 'storefront.languages';
const UCP_KEY = 'ucp.enabled';

export async function readConfig<T>(db: Database, key: string): Promise<T | null> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = ?`, [key]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeConfig(db: Database, key: string, value: unknown): Promise<void> {
  await db.run(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)],
  );
}

const isSupported = (code: unknown): code is LanguageCode =>
  typeof code === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(code);

/** Saved language settings, repaired so they are always usable. */
export async function getLanguageSettings(db: Database): Promise<LanguageSettings> {
  const saved = await readConfig<Partial<LanguageSettings>>(db, LANGUAGES_KEY);
  if (!saved) return { ...DEFAULT_LANGUAGE_SETTINGS, enabled: [...DEFAULT_LANGUAGE_SETTINGS.enabled] };
  // Keep the canonical order and drop anything the client can't load.
  const enabled = SUPPORTED_LANGUAGES.filter((c) => saved.enabled?.includes(c));
  const safeEnabled = enabled.length > 0 ? enabled : [...DEFAULT_LANGUAGE_SETTINGS.enabled];
  const def = isSupported(saved.default) && safeEnabled.includes(saved.default) ? saved.default : safeEnabled[0];
  return { enabled: safeEnabled, default: def };
}

export async function saveLanguageSettings(db: Database, settings: LanguageSettings): Promise<LanguageSettings> {
  const enabled = SUPPORTED_LANGUAGES.filter((c) => settings.enabled.includes(c));
  await writeConfig(db, LANGUAGES_KEY, { enabled, default: settings.default });
  return getLanguageSettings(db);
}

/** UCP (AI shopping agents) is on unless an admin switched it off. */
export async function isUcpEnabled(db: Database): Promise<boolean> {
  const saved = await readConfig<boolean>(db, UCP_KEY);
  return saved !== false;
}

export async function setUcpEnabled(db: Database, enabled: boolean): Promise<void> {
  await writeConfig(db, UCP_KEY, enabled);
}

/**
 * Banner links: a path inside the storefront ("/products", "/pages/about",
 * "/?category=caps") or an absolute http(s) URL. Rejects protocol-relative
 * ("//evil.example") and script URLs.
 */
export function isSafeLink(href: string): boolean {
  if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export const AVAILABILITY_VALUES = ['in_stock', 'out_of_stock', 'preorder'] as const;
export type Availability = (typeof AVAILABILITY_VALUES)[number];

/**
 * Why a variant can't be sold right now, or null if it can. Stock limits are
 * checked separately (inventory); this covers the merchant's switches.
 */
export function saleBlockReason(variant: { status?: string | null; availability?: string | null }):
  | 'inactive'
  | 'out_of_stock'
  | null {
  if (variant.status && variant.status !== 'active') return 'inactive';
  if (variant.availability === 'out_of_stock') return 'out_of_stock';
  return null;
}
