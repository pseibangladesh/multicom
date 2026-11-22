/**
 * @copyright Copyright (c) 2024-2026 Ronan LE MEILLAT
 * @license AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 *
 * @description
 * i18next setup. The language list lives in src/lib/languages.ts; to add a
 * language, add it there, add src/locales/base/<code>.json and its URL in
 * LOCALE_URLS below.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import i18nextHttpBackend, {
  type HttpBackendOptions,
} from "i18next-http-backend";

import {
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  languageDirection,
  resolveLanguage,
} from "@/lib/languages";

export {
  availableLanguages,
  languageDirection,
  type AvailableLanguage,
} from "@/lib/languages";

// Vite cannot resolve new URL(`./locales/base/${lng}.json`, import.meta.url),
// so each locale file is listed literally.
const LOCALE_URLS: Record<string, URL> = {
  "en-US": new URL("./locales/base/en-US.json", import.meta.url),
  "fr-FR": new URL("./locales/base/fr-FR.json", import.meta.url),
  "es-ES": new URL("./locales/base/es-ES.json", import.meta.url),
  "zh-CN": new URL("./locales/base/zh-CN.json", import.meta.url),
  "ar-SA": new URL("./locales/base/ar-SA.json", import.meta.url),
  "he-IL": new URL("./locales/base/he-IL.json", import.meta.url),
  "bn-BD": new URL("./locales/base/bn-BD.json", import.meta.url),
};

function storedLanguage(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Sets <html lang> and <html dir> for a language. */
function applyDocumentLanguage(code: string) {
  if (typeof document === "undefined") return;
  const lang = resolveLanguage(code);

  document.documentElement.lang = lang;
  document.documentElement.dir = languageDirection(lang);
}

/**
 * Switches the UI language: i18next, saved choice, and <html lang/dir>.
 * Direction is also applied on every languageChanged event (below), so it
 * does not depend on any particular component being mounted.
 */
export async function applyLanguage(requested: string): Promise<void> {
  const code = resolveLanguage(requested);

  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // storage unavailable: the language still applies for this visit
  }
  await i18n.changeLanguage(code);
}

i18n.on("languageChanged", applyDocumentLanguage);

// An unsupported saved code (e.g. an old "en") falls back to English.
const initialLanguage = resolveLanguage(storedLanguage());

i18n
  .use(i18nextHttpBackend)
  .use(initReactI18next) // passes i18n down to react-i18next
  .init<HttpBackendOptions>({
    lng: initialLanguage,
    fallbackLng: FALLBACK_LANGUAGE,

    ns: ["base"],
    defaultNS: "base",
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
    react: {
      transKeepBasicHtmlNodesFor: ["br", "strong", "i", "p", "sub", "sup"],
    },
    backend: {
      loadPath: (lng) =>
        (LOCALE_URLS[lng[0]] ?? LOCALE_URLS[FALLBACK_LANGUAGE]).toString(),
    },
  });

applyDocumentLanguage(initialLanguage);

export default i18n;
