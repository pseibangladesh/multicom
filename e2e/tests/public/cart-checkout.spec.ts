/// <reference types="node" />
/**
 * Cart checkout regression (Buy now plan, Task 5).
 *
 * Recorded against the cart page BEFORE the checkout steps were moved into
 * CheckoutFlow; the aria snapshots of each step must keep matching after the
 * move. Stripe is never called: the checkout request is intercepted.
 *
 * Needs the local API (:8787) and client (:5173): npm run test:dev:public
 */
import { test, expect, type Page } from "@playwright/test";

test.use({ locale: "en-US" });

/** In stock, shipped, in the default seed data. */
const ITEM = {
  sku: "GOLF_TEES",
  title: '{"en-US":"Pack of Golf Tees"}',
  price_cents: 890,
  currency: "EUR",
  qty: 2,
};
const SECOND = {
  sku: "TENNIS_PROTECTOR",
  title: '{"en-US":"Tennis Racket Cover"}',
  price_cents: 1490,
  currency: "EUR",
  qty: 1,
};

async function seedCart(page: Page, items: unknown[]) {
  await page.addInitScript((value) => {
    // Only on the first load, so the app's own changes survive navigation.
    if (!sessionStorage.getItem("__seeded")) {
      localStorage.setItem("merchant_cart", value);
      localStorage.setItem("i18nextLng", "en-US");
      localStorage.setItem("cookie-consent-status", "rejected");
      sessionStorage.setItem("__seeded", "1");
    }
  }, JSON.stringify(items));
}

const checkoutRegion = (page: Page) => page.getByRole("main");

test.describe("Cart checkout", () => {
  test.skip(process.env.PLAYWRIGHT_ENV !== "local", "needs the local API and seed data");

  test("cart checkout reaches payment unchanged", async ({ page, baseURL }) => {
    await seedCart(page, [ITEM, SECOND]);

    const created: unknown[] = [];
    const added: unknown[] = [];
    let checkoutBody: Record<string, string> | null = null;
    page.on("request", (req) => {
      if (req.method() !== "POST") return;
      const url = new URL(req.url());
      if (/\/v1\/carts$/.test(url.pathname)) created.push(req.postDataJSON());
      if (/\/v1\/carts\/[^/]+\/items$/.test(url.pathname)) added.push(req.postDataJSON());
    });
    await page.route(/\/v1\/carts\/[^/]+\/checkout$/, async (route) => {
      checkoutBody = route.request().postDataJSON();
      await route.fulfill({ json: { checkout_url: `${baseURL}/__stripe-test`, id: "cs_test" } });
    });

    await page.goto("/cart");
    await expect(page.getByRole("heading", { name: "Shopping Cart", level: 1 })).toBeVisible();
    await expect(checkoutRegion(page)).toMatchAriaSnapshot({ name: "cart-1-initial.aria.yml" });

    await page.locator("#email").fill("e2e-cart@example.test");
    await page.getByRole("button", { name: "Continue to Address" }).click();
    await page.getByRole("button", { name: "Continue as guest" }).click();

    await expect(page.getByRole("heading", { name: "Shipping Address" })).toBeVisible();
    await expect(checkoutRegion(page)).toMatchAriaSnapshot({ name: "cart-2-address.aria.yml" });

    await page.getByRole("textbox", { name: "Full Name" }).fill("E2E Shopper");
    await page.getByRole("textbox", { name: "Address Line 1" }).fill("1 Rue de Test");
    await page.getByRole("textbox", { name: "City" }).fill("Paris");
    await page.getByRole("textbox", { name: "Postal Code" }).fill("75001");
    await page.getByRole("button", { name: /Country/ }).click();
    await page.getByRole("option", { name: "France" }).click();
    await page.getByRole("button", { name: "Continue to Shipping Options" }).click();

    await expect(page.getByRole("heading", { name: "Shipping Method" })).toBeVisible();
    // The rate options are not exposed as radios (existing gap): click the first one.
    await page.getByRole("radiogroup").locator("> *").first().click();
    await expect(checkoutRegion(page)).toMatchAriaSnapshot({ name: "cart-3-rate.aria.yml" });
    await page.getByRole("button", { name: "Continue to Payment" }).click();

    // Today this step shows raw keys (checkout-select-payment, checkout-pay-now,
    // back-to-shipping are missing from the locale files); recorded as is.
    await expect(page.getByRole("heading", { name: /checkout-select-payment|Select Payment Method/ })).toBeVisible();
    await expect(page.getByRole("radiogroup")).toBeVisible();
    // The item list and the order summary are hidden while paying.
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(checkoutRegion(page)).toMatchAriaSnapshot({ name: "cart-4-payment.aria.yml" });

    // What the server was asked to do
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ customer_email: "e2e-cart@example.test" });
    expect(created[0]).not.toHaveProperty("source"); // the cart request is unchanged
    expect(added).toEqual([{ items: [{ sku: ITEM.sku, qty: 2 }, { sku: SECOND.sku, qty: 1 }] }]);

    await page.getByRole("button", { name: /checkout-pay-now|Pay Now/ }).click();
    await page.waitForURL(/__stripe-test/);
    expect(checkoutBody).not.toBeNull();
    expect(checkoutBody!.success_url).toMatch(/\/success\?session_id=\{CHECKOUT_SESSION_ID\}$/);
    expect(checkoutBody!.cancel_url).toMatch(/\/cart$/);
  });

  test("the success page empties the cart after a cart checkout", async ({ page }) => {
    await seedCart(page, [ITEM]);
    await page.goto("/success?session_id=cs_test_x");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("merchant_cart"))).toBe("[]");
  });
});
