/**
 * Pure SSLCommerz helpers (no I/O) so the payment rules can be unit-tested.
 * Gateway docs: https://developer.sslcommerz.com/doc/v4/
 */

/** Currencies SSLCommerz accepts for `currency` on session initiation. */
export const SSLCOMMERZ_CURRENCIES = ['BDT', 'USD', 'EUR', 'SGD', 'INR', 'MYR'] as const;

export function isSupportedCurrency(currency: string | null | undefined): boolean {
  return !!currency && (SSLCOMMERZ_CURRENCIES as readonly string[]).includes(currency.toUpperCase());
}

/** SSLCommerz amounts are decimal major units ("1250.50"), not cents. */
export function toGatewayAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function gatewayAmountToCents(amount: string | number | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** IPN `status` values. Success is `VALID` (or `VALIDATED` on a repeat). */
export type IpnOutcome = 'success' | 'failure' | 'ignore';

export function classifyIpnStatus(status: string | null | undefined): IpnOutcome {
  switch ((status || '').toUpperCase()) {
    case 'VALID':
    case 'VALIDATED':
      return 'success';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'UNATTEMPTED':
      return 'failure';
    default:
      return 'ignore';
  }
}

/** Subset of the Order Validation API response we check. */
export interface SslValidationResponse {
  status?: string;
  tran_id?: string;
  amount?: string;
  currency?: string;
  /** Original transaction currency/amount when it differs from settlement (BDT). */
  currency_type?: string;
  currency_amount?: string;
}

export interface ExpectedPayment {
  tranId: string;
  totalCents: number;
  currency: string;
}

/**
 * A payment counts only if the server-side validation API says VALID/VALIDATED
 * AND it is for this transaction, amount and currency. Never trust the IPN body.
 */
export function isValidatedPayment(v: SslValidationResponse | null, expected: ExpectedPayment): boolean {
  if (!v) return false;
  const status = (v.status || '').toUpperCase();
  if (status !== 'VALID' && status !== 'VALIDATED') return false;
  if (v.tran_id !== expected.tranId) return false;

  // For non-BDT payments `amount`/`currency` are the BDT settlement values and
  // the original values are in currency_amount/currency_type.
  const currency = (v.currency_type || v.currency || '').toUpperCase();
  const cents = gatewayAmountToCents(v.currency_type ? v.currency_amount : v.amount);
  return currency === expected.currency.toUpperCase() && cents === expected.totalCents;
}
