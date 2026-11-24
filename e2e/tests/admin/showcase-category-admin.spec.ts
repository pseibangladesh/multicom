/// <reference types="node" />
/**
 * Admin: the "Showcase only" option on categories (plan Task 7).
 * Needs a signed-in admin session in e2e/fixtures/storage-state-admin.json.
 */
import { test, expect } from "@playwright/test";

import { seriousAxeViolations } from "../../fixtures/axe";

test.use({ locale: "en-US" });

test.describe("Category admin: showcase only", () => {
  test.skip(process.env.PLAYWRIGHT_ENV !== "local", "needs the local API");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("i18nextLng", "en-US");
      localStorage.setItem("cookie-consent-status", "rejected");
    });
  });

  test("create a showcase-only category; it is tagged and hidden from the shop", async ({ page }) => {
    const handle = `e2e-admin-showcase-${Date.now().toString(36)}`;

    await page.goto("/admin/categories");
    await page.getByRole("button", { name: /create|new category|add/i }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: /handle/i }).fill(handle);
    await dialog.getByRole("textbox", { name: /name/i }).first().fill("E2E Admin Showcase");
    const showcase = dialog.getByRole("checkbox", { name: "Showcase only" });
    await showcase.check();
    // A showcase-only category can't have a parent: the parent picker goes away.
    await expect(dialog.getByText("Parent category")).toHaveCount(0);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await dialog.getByRole("button", { name: /^create$/i }).click();
    await expect(dialog).toHaveCount(0);

    const row = page.getByRole("row").filter({ hasText: handle });
    await expect(row).toContainText("Showcase");

    // Shoppers don't see it.
    const pub = await page.request.get(`${process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8787"}/v1/categories`);
    expect(((await pub.json()).items as { handle: string }[]).map((c) => c.handle)).not.toContain(handle);

    // Clean up.
    await row.getByRole("button").last().click();
    await page.getByRole("alertdialog").getByRole("button", { name: /delete/i }).click();
    await expect(page.getByRole("row").filter({ hasText: handle })).toHaveCount(0);
  });

  test("the server's nesting rule shows in the form", async ({ page }) => {
    // A category with a subcategory can't become showcase-only.
    await page.route(/\/v1\/categories\/[^/]+$/, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({ status: 400, json: { error: { code: "invalid_request", message: "A showcase-only category can't have subcategories" } } });
    });
    await page.goto("/admin/categories");
    await page.getByRole("row").nth(1).getByRole("button").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "Showcase only" }).check();
    await dialog.getByRole("button", { name: /^update$/i }).click();
    await expect(dialog.getByRole("alert")).toContainText("can't have subcategories");
  });
});
