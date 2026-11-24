/**
 * The browser side of the cart.
 *
 * Only signed-out (guest) shoppers keep their cart in the browser. A signed-in
 * customer's cart lives on the server (/v1/me/cart, hooks/use-cart.tsx), so it
 * follows them to any device and nothing of theirs stays on a shared one.
 * Signing in folds the guest cart into the account's cart.
 *
 * Kept free of React so it can be unit-tested with a fake Storage.
 */

export type CartItem = {
  sku: string;
  title: string;
  price_cents: number;
  currency?: string;
  image_url?: string;
  qty: number;
};

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;

export const GUEST_CART_KEY = "merchant_cart:guest";
/** Earlier versions: one shared key, then one key per user. Owners unknown or now server-side. */
export const LEGACY_CART_KEY = "merchant_cart";
const LEGACY_USER_PREFIX = "merchant_cart:user:";

export function readCart(storage: KV | null, key = GUEST_CART_KEY): CartItem[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) || "[]");

    return Array.isArray(parsed) ? (parsed as CartItem[]) : [];
  } catch {
    return [];
  }
}

export function writeCart(
  storage: KV | null,
  items: CartItem[],
  key = GUEST_CART_KEY,
) {
  if (!storage) return;
  try {
    if (items.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(items));
  } catch {
    /* storage full or blocked: the cart still works for this page view */
  }
}

/** Adds `extra` into `base`, summing quantities of the same SKU. */
export function mergeCarts(base: CartItem[], extra: CartItem[]): CartItem[] {
  const out = base.map((i) => ({ ...i }));

  for (const item of extra) {
    const same = out.find((i) => i.sku === item.sku);

    if (same) same.qty += item.qty;
    else out.push({ ...item });
  }

  return out;
}

/**
 * Removes carts left by earlier versions: the shared key (whose owner can't be
 * told) and per-user copies (those carts are on the server now).
 */
export function purgeLegacyCarts(storage: KV | null) {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_CART_KEY);
    const keys: string[] = [];

    for (let i = 0; i < (storage.length ?? 0); i++) {
      const k = storage.key?.(i);

      if (k?.startsWith(LEGACY_USER_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => storage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/** localStorage, or null where it is missing or blocked. */
export function browserStorage(): KV | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
