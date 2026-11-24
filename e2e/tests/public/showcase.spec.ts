/// <reference types="node" />
/**
 * Home page sections and showcase rows (plan Task 8). The sections response is
 * replaced with one built from real products, so the shop data isn't changed.
 *
 * Needs the local API (:8787) and client (:5173):
 *   set -a; . ../.env; set +a; npm run test:dev:public
 */
import { test, expect, type Page } from "@playwright/test";

import { seriousAxeViolations } from "../../fixtures/axe";

test.use({ locale: "en-US" });

const API = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8787";
/** The storefront's public key (root .env), needed to list products. */
const PK = process.env.MERCHANT_PK;

async function seed(page: Page, opts: { theme?: string; lang?: string; reducedMotion?: boolean } = {}) {
  await page.addInitScript(
    ([theme, lang]) => {
      localStorage.setItem("i18nextLng", lang || "en-US");
      localStorage.setItem("preferredLanguage", lang || "en-US");
      localStorage.setItem("cookie-consent-status", "rejected");
      if (theme) localStorage.setItem("theme", theme);
    },
    [opts.theme ?? "", opts.lang ?? ""] as const,
  );
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
}

/** Banner, an "Offers" row with `count` real products, then the catalogue. */
async function mockHome(page: Page, count = 12, order: string[] = ["banner", "showcase", "catalogue"]) {
  const res = await page.request.get(`${API}/v1/products?limit=${count + 4}&status=active&thumbnail=true`, {
    headers: { Authorization: `Bearer ${PK}` },
  });
  expect(res.ok()).toBe(true);
  const list = await res.json();
  // Like the server, rows only carry products with variants.
  list.items = list.items.filter((p: { variants: unknown[] }) => p.variants.length > 0);
  const sections = order.map((type) =>
    type === "showcase"
      ? { id: "s-offers", type, title: '{"en-US":"Offers","ar-SA":"العروض"}', products: list.items.slice(0, count) }
      : { id: `builtin-${type}`, type, title: null },
  );
  await page.route(/\/v1\/storefront\/home$/, (route) => route.fulfill({ json: { sections } }));
}

const row = (page: Page, name = /Offers|العروض/) => page.getByRole("region", { name });
const strip = (page: Page) => row(page).getByRole("list");
const scrollPos = (page: Page) => strip(page).evaluate((el) => Math.abs(el.scrollLeft));

test.describe("Home sections", () => {
  test.skip(process.env.PLAYWRIGHT_ENV !== "local" || !PK, "needs the local API, seed data and MERCHANT_PK");

  test("home follows the section order", async ({ page }) => {
    await seed(page);
    await mockHome(page, 6, ["showcase", "catalogue", "banner"]);
    await page.goto("/");
    await expect(row(page)).toBeVisible();
    const headings = await page.getByRole("main").getByRole("heading").allInnerTexts();
    const iOffers = headings.indexOf("Offers");
    const iProducts = headings.indexOf("Products");
    expect(iOffers).toBeGreaterThanOrEqual(0);
    expect(iOffers).toBeLessThan(iProducts);
    // The hero (banner) comes last here: its <h1> is after the catalogue heading.
    const h1 = await page.getByRole("heading", { level: 1 }).first().evaluate((el) => el.getBoundingClientRect().top);
    const catalogue = await page.getByRole("heading", { name: "Products" }).evaluate((el) => el.getBoundingClientRect().top);
    expect(h1).toBeGreaterThan(catalogue);
  });

  test("row scrolls with the buttons and stops at the ends", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page);
    await mockHome(page, 12);
    await page.goto("/");
    const prev = row(page).getByRole("button", { name: "Previous products in Offers" });
    const next = row(page).getByRole("button", { name: "Next products in Offers" });
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => scrollPos(page)).toBeGreaterThan(100);
    await expect(prev).toBeEnabled();
    for (let i = 0; i < 6 && (await next.isEnabled()); i++) await next.click();
    await expect(next).toBeDisabled();
  });

  test("row works by keyboard: focused cards scroll into view", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page);
    await mockHome(page, 12);
    await page.goto("/");
    const links = strip(page).locator("li a:not([aria-hidden='true'])");
    const last = links.last();
    await last.focus();
    await expect(last).toBeFocused();
    await expect.poll(() => scrollPos(page)).toBeGreaterThan(100);
    // The row scrolls smoothly; wait until the focused card is fully inside it.
    await expect
      .poll(async () => {
        const box = (await strip(page).boundingBox())!;
        const card = (await last.boundingBox())!;

        return card.x >= box.x - 1 && card.x + card.width <= box.x + box.width + 1;
      })
      .toBe(true);
  });

  test("phone: shows part of the next card, no buttons, no page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await seed(page);
    await mockHome(page, 6);
    await page.goto("/");
    await expect(row(page)).toBeVisible();
    await expect(row(page).getByRole("button", { name: /Next products/ })).toBeHidden();
    const widths = await strip(page).evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(widths.scroll).toBeGreaterThan(widths.client);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("RTL: Next moves towards the end in Arabic", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, { lang: "ar-SA" });
    await mockHome(page, 12);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await row(page).getByRole("button").nth(1).click();
    await expect.poll(() => strip(page).evaluate((el) => el.scrollLeft)).toBeLessThan(-100);
  });

  test("reduced motion: the row jumps instead of animating", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seed(page, { reducedMotion: true });
    await mockHome(page, 12);
    await page.goto("/");
    await row(page).getByRole("button", { name: /Next products/ }).click();
    // No smooth animation: the new position is there straight away.
    expect(await scrollPos(page)).toBeGreaterThan(100);
  });

  test("falls back to banner + catalogue when the home request fails", async ({ page }) => {
    await seed(page);
    await page.route(/\/v1\/storefront\/home$/, (route) => route.fulfill({ status: 500, json: {} }));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
  });

  test("a link to a hidden category says it isn't available", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await seed(page);
    await page.goto("/?category=offers-hidden-e2e");
    await expect(page.getByRole("heading", { name: "Category not found", level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [390, 1440]) {
      test(`no serious accessibility issues (${theme}, ${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await seed(page, { theme });
        await mockHome(page, 8);
        await page.goto("/");
        await expect(row(page)).toBeVisible();
        expect(await seriousAxeViolations(page)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      });
    }
  }
});
