import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkoutCart,
  checkoutCartSslcommerz,
  enabledPaymentMethods,
  getPaymentMethods,
} from "@/lib/store-api";
import { paymentReturnMessageKey } from "@/lib/payment-return";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("checkoutCartSslcommerz", () => {
  it("POSTs a JSON body to the API (not the SPA origin) with the public key", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ gateway_url: "https://sandbox.sslcommerz.com/pay/x" }),
    );

    await expect(checkoutCartSslcommerz("cart-1")).resolves.toEqual({
      gateway_url: "https://sandbox.sslcommerz.com/pay/x",
    });

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe("https://api.test/v1/carts/cart-1/checkout/sslcommerz");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}"); // the route validates a JSON body
    expect(init.headers.Authorization).toBe("Bearer pk_test");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("surfaces the server's error message", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "SSLCommerz is not configured." } }, 400),
    );
    await expect(checkoutCartSslcommerz("cart-1")).rejects.toThrow(
      "SSLCommerz is not configured.",
    );
  });
});

describe("checkoutCart (Stripe)", () => {
  it("sends success/cancel URLs and returns the Stripe checkout URL", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ checkout_url: "https://checkout.stripe.com/c/pay/x" }),
    );

    const res = await checkoutCart(
      "cart-1",
      "https://shop.test/success?session_id={CHECKOUT_SESSION_ID}",
      "https://shop.test/cart",
    );

    expect(res.checkout_url).toBe("https://checkout.stripe.com/c/pay/x");
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe("https://api.test/v1/carts/cart-1/checkout");
    expect(JSON.parse(init.body)).toEqual({
      success_url: "https://shop.test/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://shop.test/cart",
    });
  });
});

describe("paymentReturnMessageKey", () => {
  it("maps SSLCommerz return params to messages", () => {
    expect(paymentReturnMessageKey("failed")).toBe("checkout-payment-failed");
    expect(paymentReturnMessageKey("cancelled")).toBe(
      "checkout-payment-cancelled",
    );
    expect(paymentReturnMessageKey(null)).toBeNull();
    expect(paymentReturnMessageKey("whatever")).toBeNull();
  });
});

describe("payment methods", () => {
  it("GETs /v1/payment-methods from the API", async () => {
    const body = { stripe: { enabled: true, publishable_key: "pk_test_x" }, sslcommerz: { enabled: false } };

    fetchMock.mockResolvedValueOnce(json(body));
    await expect(getPaymentMethods()).resolves.toEqual(body);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/payment-methods$/);
  });

  it("lists only the enabled gateways, Stripe first", () => {
    const off = { enabled: false, publishable_key: null };

    expect(enabledPaymentMethods({ stripe: { enabled: true, publishable_key: null }, sslcommerz: { enabled: true } })).toEqual(["stripe", "sslcommerz"]);
    expect(enabledPaymentMethods({ stripe: off, sslcommerz: { enabled: true } })).toEqual(["sslcommerz"]);
    expect(enabledPaymentMethods({ stripe: off, sslcommerz: { enabled: false } })).toEqual([]);
  });
});
