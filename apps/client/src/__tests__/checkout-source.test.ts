import { describe, it, expect } from "vitest";

import {
  CHECKOUT_SOURCE_KEY,
  buyNowHref,
  forgetCheckoutSource,
  markCheckoutSource,
  parseBuyNowParams,
  shouldClearCart,
} from "@/lib/checkout-source";

/** In-memory Storage (the unit tests run in node, without a DOM). */
function memoryStorage(): Storage {
  const m = new Map<string, string>();

  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const throwing: Storage = {
  length: 0,
  clear() {},
  key: () => null,
  getItem() {
    throw new Error("blocked");
  },
  setItem() {
    throw new Error("blocked");
  },
  removeItem() {
    throw new Error("blocked");
  },
};

const qs = (s: string) => new URLSearchParams(s);

describe("shouldClearCart", () => {
  it("clears after a cart checkout (Stripe or SSLCommerz)", () => {
    expect(shouldClearCart(qs("session_id=x"), memoryStorage())).toBe(true);
    expect(
      shouldClearCart(qs("gateway=sslcommerz&tran_id=t"), memoryStorage()),
    ).toBe(true);
  });

  it("keeps the cart when the return says buy_now", () => {
    expect(
      shouldClearCart(qs("session_id=x&source=buy_now"), memoryStorage()),
    ).toBe(false);
    expect(
      shouldClearCart(
        qs("gateway=sslcommerz&tran_id=t&source=buy_now"),
        memoryStorage(),
      ),
    ).toBe(false);
  });

  it("keeps the cart when only the session marker says buy_now (backstop)", () => {
    const s = memoryStorage();

    markCheckoutSource("buy_now", s);
    expect(shouldClearCart(qs("session_id=x"), s)).toBe(false);
  });

  it("a later cart checkout replaces the marker", () => {
    const s = memoryStorage();

    markCheckoutSource("buy_now", s);
    markCheckoutSource("cart", s);
    expect(shouldClearCart(qs("session_id=x"), s)).toBe(true);
  });

  it("forgetCheckoutSource removes the marker", () => {
    const s = memoryStorage();

    markCheckoutSource("buy_now", s);
    forgetCheckoutSource(s);
    expect(s.getItem(CHECKOUT_SOURCE_KEY)).toBeNull();
  });

  it("works when storage is blocked", () => {
    expect(() => markCheckoutSource("buy_now", throwing)).not.toThrow();
    expect(() => forgetCheckoutSource(throwing)).not.toThrow();
    expect(shouldClearCart(qs("session_id=x"), throwing)).toBe(true);
    expect(shouldClearCart(qs("session_id=x&source=buy_now"), throwing)).toBe(
      false,
    );
  });
});

describe("Buy now links", () => {
  it("buyNowHref encodes values", () => {
    expect(buyNowHref("p 1", "S&K=U")).toBe(
      "/buy-now?product=p+1&sku=S%26K%3DU&qty=1",
    );
    expect(buyNowHref("p1", "SKU", 3)).toBe(
      "/buy-now?product=p1&sku=SKU&qty=3",
    );
  });

  it("parseBuyNowParams clamps qty and needs product and sku", () => {
    expect(parseBuyNowParams(qs("product=p1&sku=A&qty=2"))).toEqual({
      productId: "p1",
      sku: "A",
      qty: 2,
    });
    expect(parseBuyNowParams(qs("product=p1&sku=A&qty=0"))?.qty).toBe(1);
    expect(parseBuyNowParams(qs("product=p1&sku=A&qty=500"))?.qty).toBe(99);
    expect(parseBuyNowParams(qs("product=p1&sku=A&qty=abc"))?.qty).toBe(1);
    expect(parseBuyNowParams(qs("product=p1&sku=A&qty=2.7"))?.qty).toBe(2);
    expect(parseBuyNowParams(qs("product=p1&sku=A"))?.qty).toBe(1);
    expect(parseBuyNowParams(qs("product=p1"))).toBeNull();
    expect(parseBuyNowParams(qs("sku=A"))).toBeNull();
    expect(
      parseBuyNowParams(qs(buyNowHref("p 1", "S&K=U", 4).split("?")[1])),
    ).toEqual({
      productId: "p 1",
      sku: "S&K=U",
      qty: 4,
    });
  });
});
