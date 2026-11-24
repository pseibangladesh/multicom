/// <reference types="node" />
/**
 * Showcase-only categories never reach shoppers (plan Task 7).
 * Creates a showcase-only category with a product through the admin API
 * (MERCHANT_SK from the root .env), checks the shop, then deletes it.
 *
 * Needs the local API (:8787) and client (:5173):
 *   set -a; . ../.env; set +a; npm run test:dev:public
 */
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

test.use({ locale: "en-US" });

const API = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:8787";
const SK = process.env.MERCHANT_SK;
const PRODUCT_B = "c9e2aab6-91e5-465e-bd13-fcc4f8fd8937"; // Tennis Racket Cover

test.describe("Showcase-only categories", () => {
  test.skip(process.env.PLAYWRIGHT_ENV !== "local" || !SK, "needs the local API and MERCHANT_SK");

  let api: APIRequestContext;
  let categoryId = "";
  const handle = `e2e-showcase-${Date.now().toString(36)}`;
  const name = `E2E Showcase ${handle.slice(-5)}`;

  test.beforeAll(async () => {
    api = await pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${SK}` } });
    const created = await api.post("/v1/categories", { data: { handle, name, visibility: "showcase" } });
    expect(created.status()).toBe(201);
    categoryId = (await created.json()).id;
    const added = await api.post(`/v1/categories/${categoryId}/products`, { data: { product_ids: [PRODUCT_B] } });
    expect(added.ok()).toBe(true);
  });

  test.afterAll(async () => {
    if (categoryId) await api.delete(`/v1/categories/${categoryId}`);
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("i18nextLng", "en-US");
      localStorage.setItem("cookie-consent-status", "rejected");
    });
  });

  test("is not in the shop's category lists", async ({ page }) => {
    await page.goto("/products");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test("its products show only their listed categories", async ({ page }) => {
    const res = await page.request.get(`${API}/v1/products/${PRODUCT_B}`);
    const product = await res.json();
    expect((product.categories ?? []).map((c: { handle: string }) => c.handle)).not.toContain(handle);
    // The admin list still has it, tagged.
    const all = await (await api.get("/v1/admin/categories")).json();
    expect(all.items.find((c: { handle: string }) => c.handle === handle)?.visibility).toBe("showcase");
  });

  test("a direct link to it shows no products", async ({ page }) => {
    await page.goto(`/?category=${handle}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText("Tennis Racket Cover")).toHaveCount(0);
  });
});
