/**
 * Maps the `?payment=` query param that SSLCommerz returns to (via the API's
 * /v1/webhooks/sslcommerz/return/* redirect) onto an i18n message key.
 */
export function paymentReturnMessageKey(
  payment: string | null,
): "checkout-payment-failed" | "checkout-payment-cancelled" | null {
  if (payment === "failed") return "checkout-payment-failed";
  if (payment === "cancelled") return "checkout-payment-cancelled";

  return null;
}
