import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  availableLanguages,
  languageDirection,
  resolveLanguage,
} from "@/lib/languages";

const LOCALE_DIR = join(__dirname, "../locales/base");
const load = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(join(LOCALE_DIR, `${code}.json`), "utf8"));
const placeholders = (s: string) =>
  (s.match(/{{\s*[\w.]+\s*}}/g) ?? []).map((p) => p.replace(/\s/g, "")).sort();

const EN = load("en-US");
const PLURAL = /_(zero|one|two|few|many|other)$/;
const family = (k: string) => k.replace(PLURAL, "");
const EN_FAMILIES = new Set(
  Object.keys(EN)
    .filter((k) => PLURAL.test(k))
    .map(family),
);
/** Languages have different plural forms: Arabic needs _two/_few/_many, Chinese only _other. */
const isAllowedExtra = (k: string) => EN_FAMILIES.has(family(k));
const mayOmitCount = (k: string) => /_(zero|one|two)$/.test(k);
const LOCALES = availableLanguages
  .map((l) => l.code)
  .filter((c) => c !== "en-US");

describe("languages", () => {
  it("lists seven languages with Bangla", () => {
    expect(availableLanguages.map((l) => l.code)).toEqual([
      "en-US",
      "fr-FR",
      "es-ES",
      "zh-CN",
      "ar-SA",
      "he-IL",
      "bn-BD",
    ]);
    expect(availableLanguages.find((l) => l.code === "bn-BD")?.nativeName).toBe(
      "বাংলা",
    );
  });

  it("knows text direction", () => {
    expect(languageDirection("ar-SA")).toBe("rtl");
    expect(languageDirection("he-IL")).toBe("rtl");
    expect(languageDirection("bn-BD")).toBe("ltr");
    expect(languageDirection("en-US")).toBe("ltr");
    expect(languageDirection("xx")).toBe("ltr");
  });

  it("has a locale file for every language and no extra files", () => {
    const files = readdirSync(LOCALE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
      .sort();

    expect(files).toEqual(availableLanguages.map((l) => l.code).sort());
  });
});

describe("locale parity", () => {
  it.each(LOCALES)("%s has exactly the en-US keys", (code) => {
    const keys = Object.keys(load(code)).sort();
    const missing = Object.keys(EN).filter((k) => !(k in load(code)));
    const extra = keys.filter((k) => !(k in EN) && !isAllowedExtra(k));

    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it.each(LOCALES)(
    "%s has no empty values and keeps {{placeholders}}",
    (code) => {
      const t = load(code);
      const bad = Object.keys(t).filter((k) => {
        const en = EN[k] ?? EN[`${family(k)}_other`] ?? EN[family(k)] ?? "";
        const want = placeholders(String(en));
        const got = placeholders(String(t[k]));
        const unknown = got.some((p) => !want.includes(p)); // e.g. a translated {{count}}
        const missing = want.some((p) => !got.includes(p)) && !mayOmitCount(k);

        return !String(t[k]).trim() || unknown || missing;
      });

      expect(bad).toEqual([]);
    },
  );

  it("en-US has the phase 1 shell keys", () => {
    for (const k of [
      "nav-shop",
      "nav-categories",
      "nav-cart",
      "nav-checkout",
      "nav-contact",
      "menu",
      "menu-close",
      "menu-profile",
      "menu-admin",
      "menu-language",
      "menu-theme",
      "mode-light",
      "mode-dark",
      "account-mode",
      "menu-about",
      "menu-blog",
      "search-products",
      "skip-to-content",
      "footer-blurb",
      "openapi-download",
      "nav-primary",
      "brand-home",
      "search-placeholder",
    ])
      expect(EN[k], k).toBeTruthy();
  });
});

describe("resolveLanguage", () => {
  it("keeps a supported saved language", () => {
    expect(resolveLanguage("bn-BD")).toBe("bn-BD");
    expect(resolveLanguage("ar-SA")).toBe("ar-SA");
  });

  it("falls back to English for missing or unsupported codes", () => {
    for (const v of [null, "", "en", "de-DE", "xx"]) expect(resolveLanguage(v)).toBe("en-US");
  });
});

describe("index.html pre-paint script", () => {
  const html = readFileSync(join(__dirname, "../../index.html"), "utf8");
  const list = (name: string) => {
    const m = new RegExp(`var ${name} = (\\[[^\\]]*\\])`).exec(html);

    expect(m, `var ${name} in index.html`).not.toBeNull();

    return JSON.parse(m![1]) as string[];
  };

  it("lists exactly the right-to-left languages of lib/languages.ts", () => {
    expect(list("RTL").sort()).toEqual(availableLanguages.filter((l) => l.isRTL).map((l) => l.code).sort());
  });

  it("lists exactly the supported languages of lib/languages.ts", () => {
    expect(list("SUPPORTED").sort()).toEqual(availableLanguages.map((l) => l.code).sort());
  });
});

describe("plural forms", () => {
  it.each(availableLanguages.map((l) => l.code))("%s has every plural form its language needs", (code) => {
    const t = load(code);
    const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    const missing: string[] = [];

    for (const fam of EN_FAMILIES)
      for (const f of forms) if (!String(t[`${fam}_${f}`] ?? "").trim()) missing.push(`${fam}_${f}`);
    expect(missing).toEqual([]);
  });
});
