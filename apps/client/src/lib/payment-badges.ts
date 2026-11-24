/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Footer payment badges: only for gateways the store has switched on.
 */

import type { PaymentMethodId } from "@/lib/store-api";

const BADGES: Record<PaymentMethodId, string[]> = {
  stripe: ["Visa", "Mastercard", "Stripe"],
  sslcommerz: ["Visa", "Mastercard", "SSLCommerz"],
};

export function paymentBadges(enabled: PaymentMethodId[]): string[] {
  return [...new Set(enabled.flatMap((id) => BADGES[id] ?? []))];
}
