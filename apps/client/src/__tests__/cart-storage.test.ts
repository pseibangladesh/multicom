import { describe, it, expect } from "vitest";

import {
  GUEST_CART_KEY,
  LEGACY_CART_KEY,
  mergeCarts,
  purgeLegacyCarts,
  readCart,
  writeCart,
  type CartItem,
} from "@/lib/cart-storage";

/** A Storage double with key()/length, like localStorage. */
function fakeStorage() {
  const m = new Map<string, string>();

  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    keys: () => [...m.keys()],
  };
}

const item = (sku: string, qty = 1): CartItem => ({
  sku,
  title: sku,
  price_cents: 100,
  qty,
});

describe("browser (guest) cart", () => {
  it("round-trips the guest cart; an empty cart leaves nothing behind", () => {
    const s = fakeStorage();

    writeCart(s, [item("A", 2)]);
    expect(readCart(s)).toEqual([item("A", 2)]);
    writeCart(s, []);
    expect(s.keys()).toEqual([]);
  });

  it("merging the guest cart into the account cart sums the same SKU", () => {
    expect(mergeCarts([item("A"), item("B")], [item("B", 2), item("C")])).toEqual([
      item("A"),
      item("B", 3),
      item("C"),
    ]);
  });

  it("removes carts left by earlier versions (shared key and per-user copies), keeps the guest cart", () => {
    const s = fakeStorage();

    s.setItem(LEGACY_CART_KEY, JSON.stringify([item("X")]));
    s.setItem("merchant_cart:user:alice", JSON.stringify([item("Y")]));
    s.setItem("merchant_cart:user:bob", JSON.stringify([item("Z")]));
    writeCart(s, [item("G")]);
    s.setItem("theme", "dark");

    purgeLegacyCarts(s);
    expect(s.keys().sort()).toEqual([GUEST_CART_KEY, "theme"]);
  });

  it("survives corrupt data and missing storage", () => {
    const s = fakeStorage();

    s.setItem(GUEST_CART_KEY, "{not json");
    expect(readCart(s)).toEqual([]);
    expect(readCart(null)).toEqual([]);
    expect(() => purgeLegacyCarts(null)).not.toThrow();
  });
});
