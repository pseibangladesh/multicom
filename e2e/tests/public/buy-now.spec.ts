/// <reference types="node" />
/**
 * Buy now (plan Task 6): one product straight to checkout; the cart is never
 * touched, and the success page leaves it alone after a Buy now order.
 * Stripe is never called: the checkout request is intercepted.
 *
 * Needs the local API (:8787) and client (:5173): npm run test:dev:public
 */
import { test, expect, type Page } from "@playwright/test";

import { seriousAxeViolations } from "../../fixtures/axe";

test.use({ locale: "en-US" });

const CART_A = [
  {
    sku: "GOLF_TEES",
    title: '{"en-US":"Pack of Golf Tees"}',
    price_cents: 890,
    currency: "EUR",
    qty: 1,
  },
];
/** Product B: in stock, shipped, in the default seed data. */
const B = { id: "c9e2aab6-91e5-465e-bd13-fcc4f8fd8937", sku: "TENNIS_PROTECTOR" };
const buyNowB = (qs = "qty=1") => `/buy-now?product=${B.id}&sku=${B.sku}&${qs}`;

async function seed(page: Page, opts: { theme?: "light" | "dark" } = {}) {
  await page.addInitScript(
    ([cart, theme]) => {
      if (!sessionStorage.getItem("__seeded")) {
        localStorage.setItem("merchant_cart", cart);
        localStorage.setItem("i18nextLng", "en-US");
        localStorage.setItem("cookie-consent-status", "rejected");
        if (theme) localStorage.setItem("theme", theme);
        sessionStorage.setItem("__seeded", "1");
      }
    },
    [JSON.stringify(CART_A), opts.theme ?? ""] as const,
  );
}

const localCart = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("merchant_cart") || "[]") as { sku: string; qty: number }[]);

async function toPaymentStep(page: Page) {
  await page.locator("#email").fill("e2e-buynow@example.test");
  await page.getByRole("button", { name: "Continue to Address" }).click();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByRole("textbox", { name: "Full Name" }).fill("E2E Shopper");
  await page.getByRole("textbox", { name: "Address Line 1" }).fill("1 Rue de Test");
  await page.getByRole("textbox", { name: "City" }).fill("Paris");
  await page.getByRole("textbox", { name: "Postal Code" }).fill("75001");
  await page.getByRole("button", { name: /Country/ }).click();
  await page.getByRole("option", { name: "France" }).click();
  await page.getByRole("button", { name: "Continue to Shipping Options" }).click();
  await expect(page.getByRole("heading", { name: "Shipping Method" })).toBeVisible();
  await page.getByRole("radiogroup").locator("> *").first().click();
  await page.getByRole("button", { name: "Continue to Payment" }).click();
  await expect(page.getByRole("radiogroup")).toBeVisible();
}

test.describe("Buy now", () => {
  test.skip(process.env.PLAYWRIGHT_ENV !== "local", "needs the local API and seed data");

  test("checks out one product and leaves the cart alone", async ({ page, baseURL }) => {
    await seed(page);
    const created: Record<string, unknown>[] = [];
    const added: unknown[] = [];
    let checkoutBody: Record<string, string> | null = null;
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const p = new URL(req.url()).pathname;
      if (/\/v1\/carts$/.test(p)) created.push(req.postDataJSON());
      if (/\/v1\/carts\/[^/]+\/items$/.test(p)) added.push(req.postDataJSON());
    });
    await page.route(/\/v1\/carts\/[^/]+\/checkout$/, async (route) => {
      checkoutBody = route.request().postDataJSON();
      await route.fulfill({ json: { checkout_url: `${baseURL}/__stripe-test`, id: "cs_test" } });
    });

    await page.goto(`/product/${B.id}`);
    await page.getByRole("button", { name: "Buy now" }).click();
    await expect(page).toHaveURL(new RegExp(`/buy-now\\?product=${B.id}&sku=${B.sku}&qty=1$`));
    await expect(page.getByRole("heading", { name: "Buy now", level: 1 })).toBeVisible();
    await expect(page.getByText("Tennis Racket Cover")).toBeVisible();
    await expect(page.getByText("Pack of Golf Tees")).toHaveCount(0); // only B
    await expect(page.getByRole("button", { name: "Cart (1)" })).toBeVisible();

    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page).toHaveURL(/qty=2/);

    await toPaymentStep(page);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ customer_email: "e2e-buynow@example.test", source: "buy_now" });
    expect(added).toEqual([{ items: [{ sku: B.sku, qty: 2 }] }]);
    expect(await localCart(page)).toEqual([expect.objectContaining({ sku: "GOLF_TEES", qty: 1 })]);

    await page.getByRole("button", { name: /checkout-pay-now|Pay Now/ }).click();
    await page.waitForURL(/__stripe-test/);
    expect(checkoutBody!.success_url).toMatch(/\/success\?session_id=\{CHECKOUT_SESSION_ID\}&source=buy_now$/);
    expect(checkoutBody!.cancel_url).toContain(`/buy-now?product=${B.id}&sku=${B.sku}&qty=2`);
    expect(await page.evaluate(() => sessionStorage.getItem("checkout_source"))).toBe("buy_now");

    // Back from Stripe, flag present: the cart is kept, the marker forgotten.
    await page.goto("/success?session_id=cs_test_1&source=buy_now");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("checkout_source"))).toBeNull();
    expect(await localCart(page)).toEqual([expect.objectContaining({ sku: "GOLF_TEES", qty: 1 })]);

    // A normal cart success afterwards still empties the cart.
    await page.goto("/success?session_id=cs_test_2");
    await expect.poll(() => localCart(page)).toEqual([]);
  });

  test("the session marker keeps the cart even if the return loses the flag", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await page.evaluate(() => sessionStorage.setItem("checkout_source", "buy_now"));
    await page.goto("/success?session_id=cs_test_3");
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("checkout_source"))).toBeNull();
    expect(await localCart(page)).toHaveLength(1);
  });

  test("keeps the cart when adding the item fails", async ({ page }) => {
    await seed(page);
    await page.route(/\/v1\/carts\/[^/]+\/items$/, (route) =>
      route.fulfill({ status: 400, json: { error: { code: "insufficient_stock", message: "Insufficient stock" } } }),
    );
    await page.goto(buyNowB());
    await page.locator("#email").fill("e2e-buynow@example.test");
    await page.getByRole("button", { name: "Continue to Address" }).click();
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await expect(page.getByText(/Insufficient stock/)).toBeVisible();
    await expect(page.locator("#email")).toBeVisible(); // still on the first step
    expect(await localCart(page)).toEqual([expect.objectContaining({ sku: "GOLF_TEES", qty: 1 })]);
  });

  test("an out-of-stock option can't be bought now", async ({ page }) => {
    await seed(page);
    await page.route(new RegExp(`/v1/products/${B.id}(\\?.*)?$`), async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.variants = body.variants.map((v: Record<string, unknown>) => ({ ...v, availability: "out_of_stock" }));
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`/product/${B.id}`);
    await expect(page.getByRole("button", { name: "Buy now" })).toBeDisabled();
    await page.goto(buyNowB());
    await expect(page.getByRole("alert")).toContainText("out of stock");
    await expect(page.locator("#email")).toHaveCount(0);
  });

  test("a failed payment comes back with the message and the quantity", async ({ page }) => {
    await seed(page);
    await page.goto(buyNowB("qty=2&payment=failed"));
    await expect(page.getByText("Your payment didn't go through")).toBeVisible();
    await expect(page.getByRole("group", { name: "Quantity" })).toContainText("2");
  });

  test("changing the quantity after a failed payment drops the old message", async ({ page }) => {
    await seed(page);
    await page.goto(buyNowB("qty=2&payment=failed"));
    await expect(page.getByText("Your payment didn't go through")).toBeVisible();
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page).toHaveURL(/qty=3$/);
    await expect(page).not.toHaveURL(/payment=/);
    await expect(page.getByText("Your payment didn't go through")).toHaveCount(0);
  });

  test("an unknown product or missing option says so", async ({ page }) => {
    await seed(page);
    await page.goto("/buy-now?product=00000000-0000-4000-8000-000000000000&sku=NOPE&qty=1");
    await expect(page.getByRole("alert")).toHaveText("This product isn't available any more.");
    await page.goto(`/buy-now?product=${B.id}&sku=NOPE`);
    await expect(page.getByRole("alert")).toHaveText("This product isn't available any more.");
    await page.goto("/buy-now");
    await expect(page.getByRole("alert")).toHaveText("This product isn't available any more.");
  });

  for (const theme of ["light", "dark"] as const) {
    for (const width of [390, 1440]) {
      test(`no serious accessibility issues (${theme}, ${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await seed(page, { theme });
        await page.goto(buyNowB());
        await expect(page.getByRole("heading", { name: "Buy now", level: 1 })).toBeVisible();
        await expect(page.locator("#email")).toBeVisible();
        expect(await seriousAxeViolations(page)).toEqual([]);
        // no sideways scrolling at phone width
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      });
    }
  }
});
