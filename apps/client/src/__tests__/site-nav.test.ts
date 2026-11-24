import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FOOTER_COLUMNS,
  MENU_INFO_LINKS,
  PRIMARY_NAV,
  SOCIAL_LINKS,
  isKnownPath,
  visibleLinks,
} from "@/config/navigation";

const EN: Record<string, string> = JSON.parse(
  readFileSync(join(__dirname, "../locales/base/en-US.json"), "utf8"),
);
const ALL = [
  ...PRIMARY_NAV,
  ...MENU_INFO_LINKS,
  ...FOOTER_COLUMNS.flatMap((c) => c.links),
];

describe("navigation config", () => {
  it("header nav is Shop, Categories, Checkout, Contact", () => {
    expect(PRIMARY_NAV.map((l) => [l.key, l.href])).toEqual([
      ["nav-shop", "/"],
      ["nav-categories", "/products"],
      ["nav-checkout", "/cart"],
      ["nav-contact", "/pages/contact"],
    ]);
  });

  it("every internal link points to a page that exists", () => {
    for (const l of ALL) expect(isKnownPath(l.href), l.href).toBe(true);
  });

  it("every label key exists in en-US", () => {
    for (const k of [
      ...ALL.map((l) => l.key),
      ...FOOTER_COLUMNS.map((c) => c.titleKey),
      ...SOCIAL_LINKS.map((l) => l.key),
    ])
      expect(EN[k], k).toBeTruthy();
  });

  it("social links are external https links", () => {
    for (const l of SOCIAL_LINKS) {
      expect(l.external).toBe(true);
      expect(l.href.startsWith("https://")).toBe(true);
    }
  });
});

describe("isKnownPath / visibleLinks", () => {
  it("knows app routes and CMS pages", () => {
    for (const p of [
      "/",
      "/products",
      "/cart",
      "/account",
      "/admin",
      "/login",
      "/pages/about",
      "/pages/cookie-policy",
    ])
      expect(isKnownPath(p), p).toBe(true);
  });

  it("rejects unknown paths", () => {
    expect(isKnownPath("/pages/nope")).toBe(false);
    expect(isKnownPath("/nope")).toBe(false);
    expect(isKnownPath("#contact")).toBe(false);
  });

  it("drops links to missing pages and keeps external ones", () => {
    expect(visibleLinks([{ key: "x", href: "/pages/nope" }])).toEqual([]);
    const ext = { key: "github", href: "https://github.com/x", external: true };

    expect(visibleLinks([ext])).toEqual([ext]);
  });
});
