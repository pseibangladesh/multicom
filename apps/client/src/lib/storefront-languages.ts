/**
 * Which languages the shop offers (Admin → Languages, GET /v1/storefront/settings).
 *
 * - Pickers list only enabled languages (plus the current one, so it never
 *   disappears from under the visitor).
 * - A visitor who never picked a language gets the shop's default.
 * - A visitor whose saved language was switched off is moved to the default.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { getApiBase } from "@/lib/api-base";
import {
  availableLanguages,
  type AvailableLanguage,
  LANGUAGE_STORAGE_KEY,
} from "@/lib/languages";

export interface LanguageSettings {
  enabled: string[];
  default: string;
}

export function useLanguageSettings() {
  return useQuery({
    queryKey: ["storefront-settings", "languages"],
    queryFn: async (): Promise<LanguageSettings | null> => {
      const res = await fetch(`${getApiBase()}/v1/storefront/settings`);

      if (!res.ok) return null; // offer every language

      return ((await res.json()) as { languages: LanguageSettings }).languages;
    },
    staleTime: 5 * 60_000,
  });
}

/** Languages to show in a picker. */
export function useOfferedLanguages(): AvailableLanguage[] {
  const { i18n } = useTranslation();
  const { data } = useLanguageSettings();

  if (!data) return availableLanguages;

  return availableLanguages.filter(
    (l) => data.enabled.includes(l.code) || l.code === i18n.language,
  );
}

function hasSavedChoice(): boolean {
  try {
    return Boolean(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** Mounted once in the shell: applies the default / disabled-language rules. */
export function useLanguagePolicy() {
  const { i18n } = useTranslation();
  const { data } = useLanguageSettings();

  useEffect(() => {
    if (!data) return;
    const current = i18n.language;
    const disabled = !data.enabled.includes(current);

    // Not saved: this is the shop's choice, not the visitor's.
    if ((disabled || !hasSavedChoice()) && current !== data.default) {
      void i18n.changeLanguage(data.default);
    }
  }, [data, i18n]);
}
