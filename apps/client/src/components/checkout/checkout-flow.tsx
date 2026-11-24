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

/**
 * The checkout steps (email → address → shipping rate → payment method →
 * redirect), shared by the cart page and the Buy now page.
 *
 * Moved out of pages/cart.tsx without changing markup, text or step order
 * (e2e/tests/public/cart-checkout.spec.ts holds the snapshots). It renders a
 * fragment so its cards sit in the parent's column exactly as before.
 *
 * It never reads or changes the local cart: it checks out the `items` it is
 * given, on a new server cart created with `source`.
 */
import type { ReactNode } from "react";

import { useTranslation } from "react-i18next";
import { Button, Card, Input, RadioGroup, Radio } from "@heroui/react";
import { useState, useEffect, useLayoutEffect } from "react";
import { useSearchParams } from "react-router-dom";

import {
  createCart,
  addItemsToCart,
  checkoutCart,
  checkoutCartSslcommerz,
  enabledPaymentMethods,
  getAvailableShippingRates,
  getPaymentMethods,
  type PaymentMethodId,
} from "@/lib/store-api";
import { paymentReturnMessageKey } from "@/lib/payment-return";
import { markCheckoutSource } from "@/lib/checkout-source";
import ShippingAddressForm from "@/components/shipping-address-form";
import ShippingRateSelector from "@/components/shipping-rate-selector";
import { useAuth } from "@/authentication";
import { CheckoutAuthPrompt } from "@/components/checkout-auth-prompt";
import { SavedAddressesSelector } from "@/components/saved-addresses-selector";

export type CheckoutStep =
  | "initial"
  | "shipping-address"
  | "shipping-rate"
  | "payment-method"
  | "processing";

export type CheckoutSource = "cart" | "buy_now";

export interface CheckoutFlowProps {
  /** What to check out. */
  items: { sku: string; qty: number }[];
  /** "buy_now" marks the server cart and the Stripe success URL. */
  source: CheckoutSource;
  /** Stripe cancel URL. */
  cancelUrl: string;
  /** Extra buttons beside "Continue to Address" (the cart's Clear / Save). */
  initialActions?: ReactNode;
  /** Label of the button that goes back to the first step. */
  backLabel?: string;
  /** Lets the parent hide its own content while the flow runs. */
  onStepChange?: (step: CheckoutStep) => void;
  /** The server cart (for totals), or null when back at the first step. */
  onCartChange?: (cart: any) => void;
}

/** Stripe success URL; `source=buy_now` tells the success page to keep the cart. */
export function stripeSuccessUrl(
  storeUrl: string,
  source: CheckoutSource,
): string {
  const base = `${storeUrl.replace(/\/$/, "")}/success?session_id={CHECKOUT_SESSION_ID}`;

  return source === "buy_now" ? `${base}&source=buy_now` : base;
}

export function CheckoutFlow({
  items,
  source,
  cancelUrl,
  initialActions,
  backLabel,
  onStepChange,
  onCartChange,
}: CheckoutFlowProps) {
  const { t, i18n } = useTranslation();
  const { user, isAuthenticated } = useAuth() as any;

  // Checkout workflow state
  const [step, setStep] = useState<CheckoutStep>("initial");
  const [email, setEmail] = useState("");
  const [currentCart, setCurrentCart] = useState<any>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [searchParams] = useSearchParams();

  // Layout effects, so the parent hides its item list in the same paint as
  // the step changes (a passive effect could leave it visible for a frame).
  useLayoutEffect(() => {
    onStepChange?.(step);
  }, [step]);
  useLayoutEffect(() => {
    onCartChange?.(currentCart);
  }, [currentCart]);

  // Back from SSLCommerz after a failed/cancelled payment: the order was
  // cancelled and the cart reopened by the IPN, so explain and let them retry.
  useEffect(() => {
    const key = paymentReturnMessageKey(searchParams.get("payment"));

    if (key) setCheckoutError(t(key));
    // The note went from the URL (Buy now drops it on a new attempt): clear it,
    // but never another error.
    else
      setCheckoutError((current) =>
        current === t("checkout-payment-failed") ||
        current === t("checkout-payment-cancelled")
          ? null
          : current,
      );
  }, [searchParams, t]);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  // true = show manual ShippingAddressForm; false = show SavedAddressesSelector (if authenticated)
  const [showManualAddressForm, setShowManualAddressForm] = useState(false);

  // Payment method selection
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodId>("stripe");
  // null while loading; then only the gateways switched on in Admin → Payment Gateways.
  const [availableMethods, setAvailableMethods] = useState<
    PaymentMethodId[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;

    getPaymentMethods()
      .then((m) => {
        if (cancelled) return;
        const ids = enabledPaymentMethods(m);

        setAvailableMethods(ids);
        if (ids.length > 0)
          setPaymentMethod((current) =>
            ids.includes(current) ? current : ids[0],
          );
      })
      .catch((err) => {
        console.error("Failed to load payment methods", err);
        // Older backend without /v1/payment-methods: keep the previous behaviour.
        if (!cancelled) setAvailableMethods(["stripe", "sslcommerz"]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-fill email from authenticated user for a smoother post-login return
  useEffect(() => {
    if (user?.email && !email) {
      setEmail(user.email);
    }
  }, [user?.email]);

  /**
   * Called when user clicks "Continue to Address".
   * If the user is not authenticated, shows the auth prompt first.
   * Otherwise jumps straight to creating the cart.
   */
  const handleInitialCheckoutClick = () => {
    if (!email || !email.includes("@")) {
      setCheckoutError(t("checkout-invalid-email"));

      return;
    }
    setCheckoutError(null);

    if (!isAuthenticated) {
      setShowAuthPrompt(true);
    } else {
      void proceedToAddressStep();
    }
  };

  /**
   * Creates the cart on the backend and moves to the shipping-address step.
   */
  const proceedToAddressStep = async () => {
    setShowAuthPrompt(false);
    setShowManualAddressForm(false);
    try {
      const cart = await createCart(email, i18n.language, source);

      setCurrentCart(cart);
      const updatedCart = await addItemsToCart(
        cart.id,
        items.map((i) => ({ sku: i.sku, qty: i.qty })),
      );

      setCurrentCart(updatedCart);

      // Detect digital-only carts
      let isDigitalOnly = false;

      try {
        const { items: rates } = await getAvailableShippingRates(cart.id);

        isDigitalOnly = rates.length === 0;
      } catch {
        isDigitalOnly = false;
      }

      if (isDigitalOnly) {
        await proceedToPayment(cart.id, "initial");
      } else {
        setStep("shipping-address");
      }
    } catch (err: any) {
      setCheckoutError(err?.message || t("checkout-failed"));
      console.error("Checkout error:", err);
    }
  };

  const handleShippingAddressSuccess = async (cart: any) => {
    setCurrentCart(cart);
    setStep("shipping-rate");
  };

  /** Redirect to payment gateway for the given cart id. */
  const proceedToPayment = async (
    cartId: string,
    fallbackStep: CheckoutStep = "shipping-rate",
  ) => {
    setStep("processing");
    try {
      if (paymentMethod === "sslcommerz") {
        const { gateway_url } = await checkoutCartSslcommerz(cartId);

        markCheckoutSource(source);
        window.location.href = gateway_url;
      } else {
        // Stripe checkout (existing flow)
        const { checkout_url } = await checkoutCart(
          cartId,
          stripeSuccessUrl(import.meta.env.STORE_URL || "", source),
          cancelUrl,
        );

        markCheckoutSource(source);
        window.location.href = checkout_url;
      }
    } catch (err: any) {
      setCheckoutError(err?.message || t("checkout-failed"));
      setStep(fallbackStep);
      console.error("Checkout error:", err);
    }
  };

  const handleShippingRateSelect = async (cart: any) => {
    setCurrentCart(cart);
    // After selecting shipping rate, show payment method selection
    setStep("payment-method");
  };

  const handleBackToAddresses = () => {
    setStep("shipping-address");
  };

  const handleBackToStart = () => {
    setStep("initial");
    setCurrentCart(null);
    setCheckoutError(null);
    setShowManualAddressForm(false);
  };

  return (
    <>
      {/* Step 1: Email input */}
      {step === "initial" && (
        <Card className="border border-bx-line bg-bx-surface-raised shadow-none">
          <Card.Header>
            <h2 className="font-display text-xl text-bx-ink">
              {t("checkout")}
            </h2>
          </Card.Header>
          <Card.Content className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-sm text-bx-ink-soft"
              >
                {t("email-label")}
              </label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleInitialCheckoutClick();
                }}
                fullWidth
                placeholder="customer@example.com"
              />
            </div>

            {checkoutError && (
              <p className="text-red-400 text-sm">{checkoutError}</p>
            )}

            <p className="text-sm text-default-500">
              {t("checkout-continue-note")}
            </p>

            <div className="flex flex-wrap justify-between gap-3">
              <div className="flex gap-2">{initialActions}</div>
              <Button
                variant="primary"
                onClick={handleInitialCheckoutClick}
                isDisabled={!email}
              >
                {t("continue-to-address") || "Continue to Address"}
              </Button>
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Step 2: Shipping address */}
      {step === "shipping-address" &&
        currentCart &&
        (isAuthenticated && !showManualAddressForm ? (
          <SavedAddressesSelector
            cartId={currentCart.id}
            onSuccess={handleShippingAddressSuccess}
            onAddNew={() => setShowManualAddressForm(true)}
          />
        ) : (
          <ShippingAddressForm
            cartId={currentCart.id}
            onSuccess={handleShippingAddressSuccess}
          />
        ))}

      {/* Step 3: Shipping rate selection */}
      {step === "shipping-rate" && currentCart && (
        <ShippingRateSelector
          cartId={currentCart.id}
          onSelect={handleShippingRateSelect}
          onBack={handleBackToAddresses}
        />
      )}

      {/* Step 3.5: Payment method selection */}
      {step === "payment-method" && currentCart && (
        <Card className="border border-bx-line bg-bx-surface-raised shadow-none">
          <Card.Header>
            <h2 className="font-display text-xl text-bx-ink">
              {t("checkout-select-payment") || "Select Payment Method"}
            </h2>
          </Card.Header>
          <Card.Content className="space-y-4">
            {availableMethods === null ? (
              <p className="text-sm text-default-500">
                {t("loading", "Loading...")}
              </p>
            ) : availableMethods.length === 0 ? (
              <p className="text-sm text-danger">
                {t(
                  "checkout-no-payment-methods",
                  "Online payment is not available right now. Please contact the store.",
                )}
              </p>
            ) : (
              <RadioGroup
                value={paymentMethod}
                onChange={(v: string) => setPaymentMethod(v as PaymentMethodId)}
              >
                {availableMethods.includes("stripe") && (
                  <Radio value="stripe" className="shrink-0">
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    💳 Stripe (Credit/Debit Card)
                  </Radio>
                )}
                {availableMethods.includes("sslcommerz") && (
                  <Radio value="sslcommerz" className="shrink-0">
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    🇧🇩 SSLCommerz (Bangladesh)
                  </Radio>
                )}
              </RadioGroup>
            )}

            <div className="flex gap-3 pt-4">
              <Button
                variant="primary"
                isDisabled={!availableMethods?.includes(paymentMethod)}
                onPress={() => void proceedToPayment(currentCart.id)}
              >
                {t("checkout-pay-now") || "Pay Now"}
              </Button>
              <Button
                variant="secondary"
                onPress={() => setStep("shipping-rate")}
              >
                {t("back-to-shipping")}
              </Button>
            </div>
          </Card.Content>
        </Card>
      )}

      {/* Processing step */}
      {step === "processing" && (
        <Card className="border-default-200">
          <Card.Content className="text-center py-8">
            <p className="text-default-500 mb-4">{t("processing")}</p>
            <p className="text-sm text-default-400">
              {paymentMethod === "sslcommerz"
                ? t("redirecting-to-sslcommerz")
                : t("redirecting-to-payment")}
            </p>
          </Card.Content>
        </Card>
      )}

      {/* Back to the first step (shown during address/shipping/payment steps) */}
      {(step === "shipping-address" ||
        step === "shipping-rate" ||
        step === "payment-method") && (
        <Button variant="outline" onPress={handleBackToStart} size="sm">
          {backLabel ?? t("back-to-cart")}
        </Button>
      )}

      {/* Auth prompt modal — shown after email step when user is not logged in */}
      <CheckoutAuthPrompt
        isOpen={showAuthPrompt}
        onClose={() => setShowAuthPrompt(false)}
        onContinueAsGuest={() => void proceedToAddressStep()}
      />
    </>
  );
}
