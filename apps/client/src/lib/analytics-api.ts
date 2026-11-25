/**
 * GET /v1/analytics/dashboard, shared by the admin dashboard (/admin) and the
 * analytics page (/admin/analytics). One query per period, so switching
 * between pages reuses the data.
 */
import { useQuery } from "@tanstack/react-query";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { resolveTitle } from "@/utils/description";

export type AnalyticsPeriod = "7d" | "30d" | "90d" | "all";

export interface AnalyticsDashboard {
  revenue: {
    total_cents: number;
    order_count: number;
    avg_order_cents: number;
  };
  customers: { total: number; new: number | null; returning: number | null };
  top_products: {
    product_id: string;
    product_title: string;
    units_sold: number;
    revenue_cents: number;
  }[];
  orders_by_status: { status: string; count: number }[];
  low_stock_count: number;
  /** Per day (YYYY-MM-DD), or per month (YYYY-MM) for "all". */
  orders_over_time: { date: string; orders: number; revenue_cents: number }[];
  sales_by_category: {
    category_id: string;
    name: string;
    units_sold: number;
    revenue_cents: number;
  }[];
  orders_by_source: { source: string; orders: number; revenue_cents: number }[];
  currencies: string[];
}

export const analyticsQueryKey = (period: AnalyticsPeriod) => [
  "admin-analytics",
  "dashboard",
  period,
];

/**
 * A failed request shows its error (with a retry button) after one retry,
 * rather than a spinner during three back-off retries.
 */
export const ADMIN_QUERY_RETRY = (failures: number, error: Error) =>
  failures < 1 && !/HTTP 40[13]/.test(error.message);

export function useAnalyticsDashboard(period: AnalyticsPeriod) {
  const { getJson } = useSecuredApi();

  return useQuery<AnalyticsDashboard, Error>({
    queryKey: analyticsQueryKey(period),
    queryFn: () =>
      getJson(
        `${getApiBase()}/v1/analytics/dashboard?period=${period}`,
      ) as Promise<AnalyticsDashboard>,
    staleTime: 60_000,
    retry: ADMIN_QUERY_RETRY,
  });
}

/** "2026-11-21" → "Nov 21"; "2026-11" → "Nov 2026" (in the UI language). */
export function bucketLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, (m || 1) - 1, d || 1));

  return new Intl.DateTimeFormat(
    locale,
    d
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", year: "numeric", timeZone: "UTC" },
  ).format(at);
}

/**
 * Formats revenue. Orders can be in several currencies and the API sums them;
 * with one currency it's shown as money, otherwise as a plain number (the
 * page says the figures mix currencies).
 */
export function revenueFormatter(currencies: string[], locale: string) {
  const currency = currencies.length === 1 ? currencies[0] : null;
  const money = currency
    ? new Intl.NumberFormat(locale, { style: "currency", currency })
    : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const compact = currency
    ? new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      })
    : new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      });

  return {
    full: (cents: number) => money.format(cents / 100),
    axis: (cents: number) => compact.format(cents / 100),
  };
}

/** Category or product names are plain text or per-locale JSON. */
export const localName = (raw: string, locale: string) =>
  resolveTitle(raw, locale) || raw;
