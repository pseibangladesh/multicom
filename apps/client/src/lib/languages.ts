/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Supported languages. Kept free of i18next and browser globals so it can be
 * imported anywhere (including node unit tests). To add a language: add it
 * here, add src/locales/base/<code>.json, and add its URL in src/i18n.ts.
 */

export interface AvailableLanguage {
  code: string; // BCP 47 language tag, e.g. "en-US"
  nativeName: string; // Name of the language in that language
  isRTL: boolean; // Right-to-left script
  isDefault?: boolean; // Used as the i18next fallback language
}

export const availableLanguages: AvailableLanguage[] = [
  { code: "en-US", nativeName: "English", isRTL: false, isDefault: true },
  { code: "fr-FR", nativeName: "Français", isRTL: false },
  { code: "es-ES", nativeName: "Español", isRTL: false },
  { code: "zh-CN", nativeName: "中文", isRTL: false },
  { code: "ar-SA", nativeName: "العربية", isRTL: true },
  { code: "he-IL", nativeName: "עברית", isRTL: true },
  { code: "bn-BD", nativeName: "বাংলা", isRTL: false },
];

export const FALLBACK_LANGUAGE = "en-US";

/** localStorage key holding the visitor's chosen language. */
export const LANGUAGE_STORAGE_KEY = "preferredLanguage";

export function languageDirection(code: string): "rtl" | "ltr" {
  return availableLanguages.find((l) => l.code === code)?.isRTL ? "rtl" : "ltr";
}

/** A saved language code, if supported; otherwise English. */
export function resolveLanguage(stored: string | null | undefined): string {
  return availableLanguages.some((l) => l.code === stored)
    ? (stored as string)
    : FALLBACK_LANGUAGE;
}
