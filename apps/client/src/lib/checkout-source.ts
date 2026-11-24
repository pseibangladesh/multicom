/**
 * Buy now vs cart checkout, on the client.
 *
 * A Buy now order must never empty the shopper's cart. The payment return
 * says so (`source=buy_now` on /success, set by the Stripe success URL and by
 * the server's SSLCommerz return). As a backstop, in case that flag is lost,
 * the checkout also leaves a marker in sessionStorage just before redirecting
 * to the gateway; the success page reads it, then forgets it.
 *
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md §2
 */
import type { CheckoutSource } from "@/components/checkout/checkout-flow";

export const CHECKOUT_SOURCE_KEY = "checkout_source";

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/** Remember which checkout is about to redirect to the payment gateway. */
export function markCheckoutSource(
  source: CheckoutSource,
  storage: Storage | undefined = sessionStore(),
): void {
  try {
    storage?.setItem(CHECKOUT_SOURCE_KEY, source);
  } catch {
    // Private mode / blocked storage: the URL flag still works.
  }
}

/** The success page calls this once it has decided. */
export function forgetCheckoutSource(
  storage: Storage | undefined = sessionStore(),
): void {
  try {
    storage?.removeItem(CHECKOUT_SOURCE_KEY);
  } catch {
    // ignore
  }
}

/** Should the success page empty the local cart? Not after a Buy now order. */
export function shouldClearCart(
  params: URLSearchParams,
  storage: Storage | undefined = sessionStore(),
): boolean {
  if (params.get("source") === "buy_now") return false;
  try {
    if (storage?.getItem(CHECKOUT_SOURCE_KEY) === "buy_now") return false;
  } catch {
    // ignore
  }

  return true;
}

export const BUY_NOW_MAX_QTY = 99;

/** Link to the Buy now page for one variant. */
export function buyNowHref(productId: string, sku: string, qty = 1): string {
  const q = new URLSearchParams({ product: productId, sku, qty: String(qty) });

  return `/buy-now?${q.toString()}`;
}

/** Reads /buy-now?product=…&sku=…&qty=…; qty is clamped to 1–99. */
export function parseBuyNowParams(
  params: URLSearchParams,
): { productId: string; sku: string; qty: number } | null {
  const productId = params.get("product");
  const sku = params.get("sku");

  if (!productId || !sku) return null;
  const n = Math.floor(Number(params.get("qty")));
  const qty = Number.isFinite(n)
    ? Math.min(Math.max(n, 1), BUY_NOW_MAX_QTY)
    : 1;

  return { productId, sku, qty };
}
