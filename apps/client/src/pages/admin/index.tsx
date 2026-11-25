/**
 * Admin dashboard (/admin): orders over the last 7 or 30 days and units sold
 * by category (GET /v1/analytics/dashboard), quick links to the main
 * sections, every admin module, and the latest orders.
 * Protected by <AdminGuard> in App.tsx; the API calls use the Better Auth
 * session cookie via useSecuredApi (credentials: "include").
 */
import type { LucideIcon } from "lucide-react";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Button } from "@heroui/react";
import {
  ArrowRight,
  CreditCard,
  Package,
  Receipt,
  RotateCw,
} from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { ADMIN_NAV } from "@/config/admin-nav";
import { formatMoney } from "@/utils/currency";
import {
  ChartCard,
  PeriodToggle,
  foldSlices,
} from "@/components/charts/chart-kit";
import { ShareDonut, TimeBarChart } from "@/components/charts/charts";
import {
  ADMIN_QUERY_RETRY,
  bucketLabel,
  localName,
  useAnalyticsDashboard,
} from "@/lib/analytics-api";

interface DashboardOrder {
  id: string;
  number?: string;
  customer_email: string;
  status: string;
  amounts: { total_cents: number; currency?: string };
  created_at: string;
}

interface GatewayStatus {
  sslcommerz?: { enabled: boolean; sandbox: boolean };
  stripe?: { enabled: boolean; mode?: string };
}

type ChartPeriod = "7d" | "30d";

/** Error text plus a retry button, used by every widget on the page. */
function LoadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex flex-wrap items-center gap-3 text-sm text-danger"
      role="alert"
    >
      <span>{message}</span>
      <Button size="sm" variant="tertiary" onPress={onRetry}>
        <RotateCw aria-hidden className="h-3.5 w-3.5" />
        {t("admin-common-retry")}
      </Button>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "paid" || status === "delivered" || status === "shipped"
      ? "bg-bx-accent-soft text-bx-accent"
      : status === "canceled" || status === "refunded"
        ? "bg-danger/10 text-danger"
        : "bg-bx-indigo-tint text-bx-ink";

  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {status}
    </span>
  );
}

function SectionCard({
  to,
  icon: Icon,
  title,
  desc,
  stat,
}: {
  to: string;
  icon: LucideIcon;
  title: string;
  desc: string;
  stat?: React.ReactNode;
}) {
  return (
    <RouterLink
      className="bx-admin-tile group relative block overflow-hidden rounded-md border border-bx-line bg-bx-surface-raised p-5 transition-all hover:-translate-y-0.5 hover:border-bx-primary focus-visible:border-bx-primary"
      to={to}
    >
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-bx-indigo-tint text-bx-primary">
          <Icon aria-hidden className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1 font-semibold text-bx-ink">
            {title}
            <ArrowRight
              aria-hidden
              className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100"
            />
          </h2>
          <p className="mt-1 text-sm text-bx-stone">{desc}</p>
          {stat && <div className="mt-3 text-sm text-bx-ink">{stat}</div>}
        </div>
      </div>
    </RouterLink>
  );
}

export default function AdminDashboardPage() {
  const { t, i18n } = useTranslation();
  const { getJson } = useSecuredApi();
  const apiBase = getApiBase();
  const lang = i18n.language;
  const [period, setPeriod] = useState<ChartPeriod>("7d");

  const analytics = useAnalyticsDashboard(period);

  const orders = useQuery<{ items?: DashboardOrder[] }, Error>({
    queryKey: ["admin-dashboard", "recent-orders"],
    queryFn: () => getJson(`${apiBase}/v1/orders?limit=5`),
    retry: ADMIN_QUERY_RETRY,
  });

  const gateways = useQuery<GatewayStatus, Error>({
    queryKey: ["admin-dashboard", "payment-gateways"],
    queryFn: () => getJson(`${apiBase}/v1/admin/settings/payment-gateways`),
    retry: ADMIN_QUERY_RETRY,
  });

  const recent = orders.data?.items ?? [];
  const ssl = gateways.data?.sslcommerz;
  const stripe = gateways.data?.stripe;
  const series = (analytics.data?.orders_over_time ?? []).map((p) => ({
    label: bucketLabel(p.date, lang),
    value: p.orders,
  }));
  const ordersInPeriod = series.reduce((s, p) => s + p.value, 0);
  const slices = foldSlices(
    (analytics.data?.sales_by_category ?? []).map((s) => ({
      label: localName(s.name, lang),
      value: s.units_sold,
    })),
    t("admin-charts-other"),
  );

  const periodToggle = (
    <PeriodToggle
      periods={["7d", "30d"] as const}
      value={period}
      onChange={setPeriod}
    />
  );

  const onOff = (on: boolean | undefined) =>
    on ? t("admin-dashboard-enabled") : t("admin-dashboard-disabled");

  return (
    <div className="space-y-8">
      <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
        {t("admin-dashboard-title")}
      </h1>

      {/* ── Charts ─────────────────────────────────────────────────────── */}
      {analytics.isError ? (
        <div className="rounded-md border border-bx-line bg-bx-surface-raised p-5">
          <LoadError
            message={`${t("admin-charts-load-error")} (${analytics.error.message})`}
            onRetry={() => analytics.refetch()}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <ChartCard
            actions={periodToggle}
            className="lg:col-span-3"
            empty={!analytics.isPending && ordersInPeriod === 0}
            emptyText={t("admin-charts-no-orders")}
            subtitle={
              analytics.isPending
                ? t("loading")
                : t("admin-charts-orders-total", { count: ordersInPeriod })
            }
            table={{
              columns: [t("date"), t("admin-analytics-orders")],
              rows: series.map((p) => [p.label, p.value]),
            }}
            title={t("admin-charts-orders-title")}
          >
            {analytics.isPending ? (
              <div className="h-60 animate-pulse rounded bg-bx-indigo-tint/50" />
            ) : (
              <TimeBarChart
                data={series}
                seriesName={t("admin-analytics-orders")}
              />
            )}
          </ChartCard>

          <ChartCard
            className="lg:col-span-2"
            empty={!analytics.isPending && slices.length === 0}
            emptyText={t("admin-charts-no-sales")}
            subtitle={t("admin-charts-category-subtitle")}
            table={{
              columns: [t("categories"), t("admin-analytics-units")],
              rows: slices.map((s) => [s.label, s.value]),
            }}
            title={t("admin-charts-category-title")}
          >
            {analytics.isPending ? (
              <div className="mx-auto h-48 w-48 animate-pulse rounded-full bg-bx-indigo-tint/50" />
            ) : (
              <ShareDonut data={slices} />
            )}
          </ChartCard>
        </div>
      )}

      {/* ── Main sections ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SectionCard
          desc={t("admin-dashboard-products-desc")}
          icon={Package}
          title={t("admin-products-title")}
          to="/admin/products"
          stat={
            analytics.data && (
              <span className="text-bx-stone">
                {t("admin-dashboard-low-stock", {
                  count: analytics.data.low_stock_count,
                })}
              </span>
            )
          }
        />
        <SectionCard
          desc={t("admin-dashboard-orders-desc")}
          icon={Receipt}
          title={t("admin-orders-title")}
          to="/admin/orders"
          stat={
            analytics.data && (
              <span className="text-bx-stone">
                {t("admin-charts-orders-total", { count: ordersInPeriod })}
              </span>
            )
          }
        />
        <SectionCard
          desc={t("admin-dashboard-payments-desc")}
          icon={CreditCard}
          title={t("admin-payment-gateways-title")}
          to="/admin/payment-gateways"
          stat={
            gateways.data && (
              <ul className="space-y-0.5 text-bx-stone">
                <li>
                  Stripe: {onOff(stripe?.enabled)}
                  {stripe?.enabled && stripe.mode ? ` (${stripe.mode})` : ""}
                </li>
                <li>
                  SSLCommerz: {onOff(ssl?.enabled)}
                  {ssl?.enabled && ssl.sandbox ? " (sandbox)" : ""}
                </li>
              </ul>
            )
          }
        />
      </div>

      {/* ── Latest orders ──────────────────────────────────────────────── */}
      <section
        aria-labelledby="admin-recent-orders"
        className="rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-5"
      >
        <header className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-bx-ink" id="admin-recent-orders">
            {t("admin-dashboard-recent-orders")}
          </h2>
          <RouterLink
            className="bx-tap inline-flex items-center text-sm text-bx-primary hover:underline"
            to="/admin/orders"
          >
            {t("admin-dashboard-view-all")}
          </RouterLink>
        </header>
        {orders.isPending && (
          <p className="text-sm text-bx-stone">{t("loading")}</p>
        )}
        {orders.isError && (
          <LoadError
            message={`${t("admin-dashboard-load-error")} (${orders.error.message})`}
            onRetry={() => orders.refetch()}
          />
        )}
        {orders.isSuccess && recent.length === 0 && (
          <p className="text-sm text-bx-stone">
            {t("admin-dashboard-no-orders")}
          </p>
        )}
        {recent.length > 0 && (
          <>
            {/* Phones: one card per order. */}
            <ul className="divide-y divide-bx-line md:hidden">
              {recent.map((o) => (
                <li key={o.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">
                      {o.number ?? o.id.slice(0, 8)}
                    </span>
                    <span className="font-medium tabular-nums">
                      {formatMoney(
                        o.amounts.total_cents,
                        o.amounts.currency ?? "",
                        lang,
                      )}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-bx-stone">
                      {o.customer_email}
                    </span>
                    <StatusPill status={o.status} />
                  </div>
                </li>
              ))}
            </ul>
            {/* Tablet and up: a table. */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="text-left text-bx-stone">
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">
                    {t("admin-orders-customer")}
                  </th>
                  <th className="py-2 font-medium">
                    {t("admin-orders-status")}
                  </th>
                  <th className="py-2 text-right font-medium">
                    {t("admin-orders-total")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {recent.map((o) => (
                  <tr
                    key={o.id}
                    className="border-t border-bx-line transition-colors hover:bg-bx-indigo-tint/40"
                  >
                    <td className="py-2 font-mono">
                      {o.number ?? o.id.slice(0, 8)}
                    </td>
                    <td className="py-2">{o.customer_email}</td>
                    <td className="py-2">
                      <StatusPill status={o.status} />
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(
                        o.amounts.total_cents,
                        o.amounts.currency ?? "",
                        lang,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      {/* ── Every admin module, from the same list as the sidebar ──────── */}
      <section aria-labelledby="admin-all-modules">
        <h2
          className="mb-4 text-lg font-semibold text-bx-ink"
          id="admin-all-modules"
        >
          {t("admin-dashboard-all-modules")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ADMIN_NAV.filter((g) => g.labelKey !== "admin-nav-overview").map(
            (group) => (
              <div
                key={group.labelKey}
                className="rounded-md border border-bx-line bg-bx-surface-raised p-4"
              >
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-bx-stone">
                  {t(group.labelKey)}
                </h3>
                <ul className="flex flex-col gap-1">
                  {group.items.map(({ href, icon: Icon, labelKey }) => (
                    <li key={href}>
                      <RouterLink
                        className="bx-tap flex items-center gap-2 rounded px-1 py-1 text-sm text-bx-ink hover:text-bx-primary hover:underline"
                        to={href}
                      >
                        <Icon aria-hidden className="h-4 w-4 text-bx-stone" />
                        {t(labelKey)}
                      </RouterLink>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      </section>
    </div>
  );
}
