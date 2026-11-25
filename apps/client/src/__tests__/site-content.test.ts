/**
 * Admin page edits are laid over the built-in text locale by locale, so an
 * edited English page keeps its French translation.
 */
import { describe, expect, it } from "vitest";

import { CMS_CONTENT, pickCmsLocale } from "@/config/cms-content";
import { isSafeExternalUrl, mergeCmsPage } from "@/lib/site-content";

const edit = { title: "Our story", lead: "Tea since 1990.", sections: [] };

describe("mergeCmsPage", () => {
  it("replaces only the edited locales", () => {
    const merged = mergeCmsPage("about", { "en-US": edit })!;

    expect(pickCmsLocale(merged, "en-US")).toEqual(edit);
    expect(pickCmsLocale(merged, "fr-FR")).toEqual(CMS_CONTENT.about["fr-FR"]);
  });

  it("uses an edit for a locale that has no built-in text", () => {
    const merged = mergeCmsPage("about", { "bn-BD": edit })!;

    expect(pickCmsLocale(merged, "bn-BD")).toEqual(edit);
    // Without the edit, Bangla visitors fall back to English.
    expect(pickCmsLocale(mergeCmsPage("about", {})!, "bn-BD")).toEqual(
      CMS_CONTENT.about["en-US"],
    );
  });

  it("returns null for pages that don't exist", () => {
    expect(mergeCmsPage("nope", { "en-US": edit })).toBeNull();
  });
});

describe("isSafeExternalUrl", () => {
  it("accepts only absolute http(s) links", () => {
    expect(isSafeExternalUrl("https://facebook.com/shop")).toBe(true);
    expect(isSafeExternalUrl(" https://wa.me/880 ")).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "facebook.com/shop",
      "//x.test",
      "",
    ]) {
      expect(isSafeExternalUrl(bad)).toBe(false);
    }
  });
});
