import { describe, expect, it } from "vitest";

import { paymentBadges } from "@/lib/payment-badges";

describe("paymentBadges", () => {
  it("shows nothing when no gateway is on", () => {
    expect(paymentBadges([])).toEqual([]);
  });

  it("shows card brands and Stripe when Stripe is on", () => {
    expect(paymentBadges(["stripe"])).toEqual(["Visa", "Mastercard", "Stripe"]);
  });

  it("shows card brands and SSLCommerz when SSLCommerz is on", () => {
    expect(paymentBadges(["sslcommerz"])).toEqual([
      "Visa",
      "Mastercard",
      "SSLCommerz",
    ]);
  });

  it("lists each brand once when both are on", () => {
    expect(paymentBadges(["stripe", "sslcommerz"])).toEqual([
      "Visa",
      "Mastercard",
      "Stripe",
      "SSLCommerz",
    ]);
  });
});
