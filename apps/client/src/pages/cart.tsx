/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { useTranslation } from "react-i18next";
import { Button, Card } from "@heroui/react";
import { useState } from "react";

import { useCart } from "@/hooks/use-cart";
import { createCart, addItemsToCart } from "@/lib/store-api";
import { formatMoney } from "@/utils/currency";
import { resolveTitleWithVariant } from "@/utils/description";
import { useAuth } from "@/authentication";
import { SaveCartButton } from "@/components/save-cart-button";
import {
  CheckoutFlow,
  type CheckoutStep,
} from "@/components/checkout/checkout-flow";

const FALLBACK_IMG = "https://placehold.co/400x400/1a1a1a/666?text=No+Image";

export default function CartPage() {
  const { t, i18n } = useTranslation();
  const { items, updateQuantity, removeItem, clear, totalCents } = useCart();
  const { user } = useAuth() as any;

  // Mirrors the checkout's step and server cart (for the totals below).
  const [step, setStep] = useState<CheckoutStep>("initial");
  const [currentCart, setCurrentCart] = useState<any>(null);

  return (
    <>
      <div className="py-2">
        <h1 className="mb-8 font-display text-3xl text-bx-ink md:text-4xl">
          {t("cart")}
        </h1>

        {items.length === 0 ? (
          <p className="text-bx-ink-soft">{t("cart-empty")}</p>
        ) : (
          // Desktop: items and checkout steps left, order summary right.
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-w-0 space-y-6">
              {/* Cart items (always shown while not processing) */}
              {step !== "processing" && step !== "payment-method" && (
                <div className="space-y-4">
                  {items.map((item) => (
                    <Card
                      key={item.sku}
                      className="border border-bx-line bg-bx-surface-raised shadow-none"
                    >
                      <Card.Content className="flex flex-row items-center gap-4">
                        <img
                          src={item.image_url || FALLBACK_IMG}
                          alt={resolveTitleWithVariant(
                            item.title,
                            i18n.language,
                          )}
                          className="w-16 h-16 object-cover rounded-lg shrink-0"
                          onError={(e) =>
                            ((e.target as HTMLImageElement).src = FALLBACK_IMG)
                          }
                        />
                        <div className="flex-1 min-w-0">
                          <p className="truncate font-medium text-bx-ink">
                            {resolveTitleWithVariant(item.title, i18n.language)}
                          </p>
                          <p className="text-sm text-default-500">
                            {formatMoney(
                              item.price_cents,
                              item.currency || "USD",
                            )}
                          </p>
                          <div className="flex items-center gap-3 mt-2">
                            <div className="flex items-center gap-1">
                              <Button
                                isIconOnly
                                size="sm"
                                aria-label={t("cart-decrease-qty")}
                                variant="ghost"
                                onPress={() =>
                                  updateQuantity(item.sku, item.qty - 1)
                                }
                              >
                                –
                              </Button>
                              <span className="px-2 text-sm text-bx-ink">
                                {item.qty}
                              </span>
                              <Button
                                isIconOnly
                                size="sm"
                                aria-label={t("cart-increase-qty")}
                                variant="ghost"
                                onPress={() =>
                                  updateQuantity(item.sku, item.qty + 1)
                                }
                              >
                                +
                              </Button>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger"
                              onPress={() => removeItem(item.sku)}
                            >
                              {t("remove")}
                            </Button>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-medium text-bx-ink">
                            {formatMoney(
                              item.price_cents * item.qty,
                              item.currency || "USD",
                            )}
                          </p>
                        </div>
                      </Card.Content>
                    </Card>
                  ))}
                </div>
              )}

              <CheckoutFlow
                items={items}
                source="cart"
                cancelUrl={window.location.href}
                onStepChange={setStep}
                onCartChange={setCurrentCart}
                initialActions={
                  <>
                    <Button variant="danger" onClick={() => clear()}>
                      {t("cart-clear")}
                    </Button>
                    <SaveCartButton
                      cartId={currentCart?.id}
                      onBeforeSave={async (): Promise<string> => {
                        if (!user?.email)
                          throw new Error("Authentication required");
                        const cart = await createCart(
                          user.email,
                          i18n.language,
                        );

                        setCurrentCart(cart);
                        await addItemsToCart(
                          cart.id,
                          items.map((i) => ({ sku: i.sku, qty: i.qty })),
                        );

                        return cart.id;
                      }}
                    />
                  </>
                }
              />
            </div>

            {/* Same steps as before: hidden while paying or processing. */}
            {step !== "processing" && step !== "payment-method" && (
              <aside className="lg:sticky lg:top-24">
                <Card className="border border-bx-line bg-bx-surface-raised shadow-none">
                  <Card.Content className="space-y-2">
                    <h2 className="mb-2 font-display text-xl text-bx-ink">
                      {t("cart-order-summary")}
                    </h2>
                    <div className="flex justify-between text-sm text-bx-ink-soft">
                      <span>{t("admin-orders-subtotal") || "Subtotal"}</span>
                      <span>
                        {formatMoney(
                          currentCart?.totals?.subtotal_cents ?? totalCents,
                          items[0]?.currency || "USD",
                        )}
                      </span>
                    </div>
                    {currentCart?.totals &&
                      currentCart.totals.discount_cents > 0 && (
                        <div className="flex justify-between text-sm text-success">
                          <span>{t("admin-orders-discount")}</span>
                          <span>
                            -
                            {formatMoney(
                              currentCart.totals.discount_cents,
                              items[0]?.currency || "USD",
                            )}
                          </span>
                        </div>
                      )}
                    {currentCart?.totals &&
                      currentCart.totals.shipping_cents > 0 && (
                        <div className="flex justify-between text-sm text-bx-ink-soft">
                          <span>
                            {t("admin-orders-shipping") || "Shipping"}
                          </span>
                          <span>
                            {formatMoney(
                              currentCart.totals.shipping_cents,
                              items[0]?.currency || "USD",
                            )}
                          </span>
                        </div>
                      )}
                    {currentCart?.totals &&
                      currentCart.totals.tax_cents > 0 && (
                        <div className="flex justify-between text-sm text-bx-ink-soft">
                          <span>
                            {currentCart.totals.tax_inclusive
                              ? t("checkout-tax-included")
                              : t("admin-orders-tax") || "Tax"}
                          </span>
                          <span>
                            {formatMoney(
                              currentCart.totals.tax_cents,
                              items[0]?.currency || "USD",
                            )}
                          </span>
                        </div>
                      )}
                    <div className="flex justify-between text-lg font-bold mt-2 border-t border-bx-line pt-2 text-bx-ink">
                      <span>{t("total")}</span>
                      <span>
                        {formatMoney(
                          currentCart?.totals?.total_cents ?? totalCents,
                          items[0]?.currency || "USD",
                        )}
                      </span>
                    </div>
                  </Card.Content>
                </Card>
              </aside>
            )}
          </div>
        )}
      </div>
    </>
  );
}
