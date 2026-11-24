/**
 * Every admin page must be reachable from the admin menu, and every menu
 * entry must lead to a real route. (Phase 1 removed the old navbar's Admin
 * dropdown and 17 admin pages became unreachable without typing the URL.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_NAV, ADMIN_NAV_ITEMS } from "@/config/admin-nav";

const app = readFileSync(join(__dirname, "..", "app.tsx"), "utf8");

/** Child paths of the <Route path="/admin"> layout route. */
function adminRoutes(): string[] {
  const start = app.indexOf('path="/admin"');
  const end = app.indexOf("</Route>", start);
  const block = app.slice(start, end);
  const children = [...block.matchAll(/path="([^"]+)"/g)]
    .map((m) => m[1])
    .slice(1);

  return ["/admin", ...children.map((c) => `/admin/${c}`)];
}

describe("admin navigation", () => {
  it("lists every admin route", () => {
    const linked = new Set(ADMIN_NAV_ITEMS.map((i) => i.href));
    const missing = adminRoutes().filter((r) => !linked.has(r));

    expect(missing).toEqual([]);
  });

  it("only links to routes that exist", () => {
    const routes = new Set([...adminRoutes(), "/openapi"]);
    const broken = ADMIN_NAV_ITEMS.map((i) => i.href).filter(
      (h) => !routes.has(h),
    );

    expect(broken).toEqual([]);
  });

  it("has no duplicate entries and covers all 24 admin pages", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(adminRoutes()).toHaveLength(24);
    expect(ADMIN_NAV.every((g) => g.items.length > 0)).toBe(true);
  });

  it("every label has an English translation", () => {
    const en = JSON.parse(
      readFileSync(
        join(__dirname, "..", "locales", "base", "en-US.json"),
        "utf8",
      ),
    ) as Record<string, string>;
    const keys = [
      ...ADMIN_NAV.map((g) => g.labelKey),
      ...ADMIN_NAV_ITEMS.map((i) => i.labelKey),
    ];

    expect(keys.filter((k) => !en[k])).toEqual([]);
  });
});
