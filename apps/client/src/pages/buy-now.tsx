/**
 * Buy now: checkout for one product, without touching the shopper's cart.
 *
 *   /buy-now?product=<id>&sku=<sku>&qty=<1-99>[&payment=failed|cancelled]
 *
 * Runs the same checkout steps as the cart (CheckoutFlow) on a server cart
 * marked source=buy_now. It never reads or writes the local cart.
 *
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md §2
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Card, Spinner } from "@heroui/react";

import { getProduct, type StoreProduct } from "@/lib/store-api";
import { BUY_NOW_MAX_QTY, parseBuyNowParams } from "@/lib/checkout-source";
import { formatMoney } from "@/utils/currency";
import { resolveTitleWithVariant } from "@/utils/description";
import { useSeoMeta } from "@/hooks/use-seo-meta";
import {
  CheckoutFlow,
  type CheckoutStep,
} from "@/components/checkout/checkout-flow";

const FALLBACK_IMG = "https://placehold.co/400x400/1a1a1a/666?text=No+Image";

export default function BuyNowPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const parsed = parseBuyNowParams(searchParams);

  const [qty, setQtyState] = useState(parsed?.qty ?? 1);
  // Follow the URL when another Buy now link opens this page in place.
  const urlQty = parsed?.qty ?? 1;

  useEffect(() => {
    setQtyState(urlQty);
  }, [urlQty]);
  const [step, setStep] = useState<CheckoutStep>("initial");
  const [serverCart, setServerCart] = useState<any>(null);

  useSeoMeta({ title: t("buy-now-title") });

  const {
    data: product,
    isLoading,
    isError,
  } = useQuery<StoreProduct, Error>({
    queryKey: ["product", parsed?.productId],
    queryFn: () => getProduct(parsed!.productId),
    enabled: !!parsed,
    retry: false,
  });

  const variant = product?.variants?.find((v) => v.sku === parsed?.sku);

  /** Keep qty in the URL, so reloads and the Stripe cancel URL keep it. */
  const setQty = (n: number) => {
    const next = Math.min(Math.max(n, 1), BUY_NOW_MAX_QTY);

    setQtyState(next);
    setSearchParams(
      (p) => {
        p.set("qty", String(next));
        // A new attempt: drop the "payment failed/cancelled" note.
        p.delete("payment");

        return p;
      },
      { replace: true },
    );
  };

  // Stripe sends a cancelled payment back here, with the same product and qty.
  const cancelUrl = useMemo(() => {
    const url = new URL(window.location.href);

    url.searchParams.delete("payment");
    url.searchParams.set("qty", String(qty));

    return url.toString();
  }, [qty, searchParams]);

  const productHref = parsed ? `/product/${parsed.productId}` : "/";

  if (!parsed || isError || (!isLoading && (!product || !variant))) {
    return (
      <div className="py-2">
        <h1 className="mb-8 font-display text-3xl text-bx-ink md:text-4xl">
          {t("buy-now-title")}
        </h1>
        <p className="mb-4 text-bx-ink-soft" role="alert">
          {t("buy-now-not-found")}
        </p>
        <Link className="text-bx-accent underline" to="/">
          {t("buy-now-continue-shopping")}
        </Link>
      </div>
    );
  }

  if (isLoading || !product || !variant) {
    return (
      <div className="flex justify-center py-16">
        <Spinner aria-label={t("loading", "Loading...")} />
      </div>
    );
  }

  const title = resolveTitleWithVariant(
    `${product.title}${variant.title ? ` - ${variant.title}` : ""}`,
    i18n.language,
  );
  const currency = variant.currency || "USD";
  const unavailable = variant.availability === "out_of_stock";
  const inFlow = step !== "initial";
  const paying = step === "payment-method" || step === "processing";

  return (
    <div className="py-2">
      <h1 className="mb-2 font-display text-3xl text-bx-ink md:text-4xl">
        {variant.availability === "preorder"
          ? t("product-preorder-now")
          : t("buy-now-title")}
      </h1>
      <p className="mb-8 text-sm text-bx-ink-soft">{t("buy-now-cart-note")}</p>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {!paying && (
            <Card className="border border-bx-line bg-bx-surface-raised shadow-none">
              <Card.Content className="flex flex-row items-center gap-4">
                <img
                  alt={title}
                  className="h-16 w-16 shrink-0 rounded-lg object-cover"
                  src={
                    variant.thumbnail_url ||
                    variant.image_url ||
                    product.image_url ||
                    FALLBACK_IMG
                  }
                  onError={(e) =>
                    ((e.target as HTMLImageElement).src = FALLBACK_IMG)
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-bx-ink">{title}</p>
                  <p className="text-sm text-bx-ink-soft">
                    {formatMoney(variant.price_cents, currency)}
                  </p>
                  {!inFlow && !unavailable && (
                    <div
                      aria-label={t("buy-now-quantity")}
                      className="mt-2 flex items-center gap-1"
                      role="group"
                    >
                      <Button
                        isIconOnly
                        aria-label={t("cart-decrease-qty")}
                        isDisabled={qty <= 1}
                        size="sm"
                        variant="ghost"
                        onPress={() => setQty(qty - 1)}
                      >
                        –
                      </Button>
                      <span
                        aria-live="polite"
                        className="px-2 text-sm text-bx-ink"
                      >
                        {qty}
                      </span>
                      <Button
                        isIconOnly
                        aria-label={t("cart-increase-qty")}
                        isDisabled={qty >= BUY_NOW_MAX_QTY}
                        size="sm"
                        variant="ghost"
                        onPress={() => setQty(qty + 1)}
                      >
                        +
                      </Button>
                    </div>
                  )}
                  {inFlow && (
                    <p className="mt-2 text-sm text-bx-ink-soft">
                      {t("buy-now-quantity")}: {qty}
                    </p>
                  )}
                </div>
                <p className="shrink-0 text-right font-medium text-bx-ink">
                  {formatMoney(variant.price_cents * qty, currency)}
                </p>
              </Card.Content>
            </Card>
          )}

          {unavailable ? (
            <p className="text-sm text-danger" role="alert">
              {t("buy-now-unavailable")}
            </p>
          ) : (
            <CheckoutFlow
              backLabel={t("buy-now-edit")}
              cancelUrl={cancelUrl}
              items={[{ sku: variant.sku, qty }]}
              source="buy_now"
              onCartChange={setServerCart}
              onStepChange={setStep}
            />
          )}

          {!inFlow && (
            <Link className="text-sm text-bx-accent underline" to={productHref}>
              {t("buy-now-back")}
            </Link>
          )}
        </div>

        {!paying && (
          <aside className="lg:sticky lg:top-24">
            <Card className="border border-bx-line bg-bx-surface-raised shadow-none">
              <Card.Content className="space-y-2">
                <h2 className="mb-2 font-display text-xl text-bx-ink">
                  {t("cart-order-summary")}
                </h2>
                <div className="flex justify-between text-sm text-bx-ink-soft">
                  <span>{t("admin-orders-subtotal")}</span>
                  <span>
                    {formatMoney(
                      serverCart?.totals?.subtotal_cents ??
                        variant.price_cents * qty,
                      currency,
                    )}
                  </span>
                </div>
                {serverCart?.totals?.shipping_cents > 0 && (
                  <div className="flex justify-between text-sm text-bx-ink-soft">
                    <span>{t("admin-orders-shipping")}</span>
                    <span>
                      {formatMoney(serverCart.totals.shipping_cents, currency)}
                    </span>
                  </div>
                )}
                {serverCart?.totals?.tax_cents > 0 && (
                  <div className="flex justify-between text-sm text-bx-ink-soft">
                    <span>
                      {serverCart.totals.tax_inclusive
                        ? t("checkout-tax-included")
                        : t("admin-orders-tax")}
                    </span>
                    <span>
                      {formatMoney(serverCart.totals.tax_cents, currency)}
                    </span>
                  </div>
                )}
                <div className="mt-2 flex justify-between border-t border-bx-line pt-2 text-lg font-bold text-bx-ink">
                  <span>{t("total")}</span>
                  <span>
                    {formatMoney(
                      serverCart?.totals?.total_cents ??
                        variant.price_cents * qty,
                      currency,
                    )}
                  </span>
                </div>
              </Card.Content>
            </Card>
          </aside>
        )}
      </div>
    </div>
  );
}
