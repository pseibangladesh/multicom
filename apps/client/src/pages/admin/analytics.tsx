/**
 * Copyright (c) 2026 Ronan LE MEILLAT
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

// apps/client/src/pages/admin/analytics.tsx
// Admin analytics: revenue over time, top products, orders by source and
// category, KPI cards, order statuses and cache stats.
// Data source: GET /v1/analytics/dashboard?period=<7d|30d|90d|all>

import type { LucideIcon } from "lucide-react";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "@heroui/react";
import {
  AlertTriangle,
  Cloud,
  Database,
  Package,
  RotateCw,
  TrendingUp,
  Users,
} from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import {
  ChartCard,
  PeriodToggle,
  foldSlices,
} from "@/components/charts/chart-kit";
import {
  RankedBarChart,
  ShareDonut,
  TimeLineChart,
} from "@/components/charts/charts";
import {
  ADMIN_QUERY_RETRY,
  type AnalyticsPeriod,
  bucketLabel,
  localName,
  revenueFormatter,
  useAnalyticsDashboard,
} from "@/lib/analytics-api";

interface CacheStatsData {
  kv: {
    hits: number;
    misses: number;
    hit_rate: number;
    entries: number;
    search_ttl_seconds: number;
    reviews_ttl_seconds: number;
    default_ttl_seconds: number;
  };
  cdn: {
    hits: number;
    misses: number;
    hit_rate: number;
  };
}

const PERIODS = ["7d", "30d", "90d", "all"] as const;
const SOURCES = ["storefront", "etsy", "ebay", "amazon"];

function Kpi({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="bx-admin-tile flex items-center gap-3 rounded-md border border-bx-line bg-bx-surface-raised p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-bx-indigo-tint text-bx-primary">
        <Icon aria-hidden className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs text-bx-stone">{label}</p>
        <p className="truncate text-xl font-bold tabular-nums text-bx-ink">
          {value}
        </p>
        {note && <p className="truncate text-xs text-bx-stone">{note}</p>}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const { getJson } = useSecuredApi();
  const apiBase = getApiBase();
  const lang = i18n.language;
  const [period, setPeriod] = useState<AnalyticsPeriod>("30d");

  const { data, isPending, isError, error, refetch } =
    useAnalyticsDashboard(period);

  const { data: cacheStats } = useQuery<CacheStatsData, Error>({
    queryKey: ["cache-stats"],
    queryFn: () =>
      getJson(`${apiBase}/v1/analytics/cache-stats`) as Promise<CacheStatsData>,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    retry: ADMIN_QUERY_RETRY,
  });

  const money = revenueFormatter(data?.currencies ?? [], lang);
  const revenueSeries = (data?.orders_over_time ?? []).map((p) => ({
    label: bucketLabel(p.date, lang),
    value: p.revenue_cents,
  }));
  const topProducts = (data?.top_products ?? []).map((p) => ({
    label: localName(p.product_title, lang),
    value: p.units_sold,
    revenue: p.revenue_cents,
  }));
  const sourceLabel = (s: string) =>
    SOURCES.includes(s) ? t(`admin-charts-source-${s}`) : s;
  const sources = foldSlices(
    (data?.orders_by_source ?? []).map((s) => ({
      label: sourceLabel(s.source),
      value: s.orders,
    })),
    t("admin-charts-other"),
  );
  const categories = foldSlices(
    (data?.sales_by_category ?? []).map((s) => ({
      label: localName(s.name, lang),
      value: s.units_sold,
    })),
    t("admin-charts-other"),
  );

  return (
    <>
      <div className="space-y-6">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
            {t("admin-analytics-title")}
          </h1>
          <PeriodToggle periods={PERIODS} value={period} onChange={setPeriod} />
        </div>

        {isPending && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-md bg-bx-indigo-tint/50"
              />
            ))}
            <span className="sr-only">{t("admin-analytics-loading")}</span>
          </div>
        )}

        {isError && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border border-bx-line bg-bx-surface-raised p-5 text-sm text-danger"
            role="alert"
          >
            <span>
              {t("admin-charts-load-error")} ({error.message})
            </span>
            <Button size="sm" variant="tertiary" onPress={() => refetch()}>
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              {t("admin-common-retry")}
            </Button>
          </div>
        )}

        {data && (
          <>
            {/* ── KPI cards ─────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                icon={TrendingUp}
                label={t("admin-analytics-revenue")}
                note={`${t("admin-analytics-avg")} ${money.full(data.revenue.avg_order_cents)}`}
                value={money.full(data.revenue.total_cents)}
              />
              <Kpi
                icon={Package}
                label={t("admin-analytics-orders")}
                value={data.revenue.order_count}
              />
              <Kpi
                icon={Users}
                label={t("admin-analytics-customers")}
                note={`${data.customers.new ?? 0} ${t("admin-analytics-customers-new")}`}
                value={data.customers.total}
              />
              <Kpi
                icon={AlertTriangle}
                label={t("admin-analytics-low-stock")}
                value={data.low_stock_count}
              />
            </div>
            {data.currencies.length > 1 && (
              <p className="text-xs text-bx-stone">
                {t("admin-charts-mixed-currencies", {
                  currencies: data.currencies.join(", "),
                })}
              </p>
            )}

            {/* ── Revenue over time ─────────────────────────────────────── */}
            <ChartCard
              empty={revenueSeries.every((p) => p.value === 0)}
              emptyText={t("admin-charts-no-sales")}
              subtitle={
                period === "all"
                  ? t("admin-charts-per-month")
                  : t("admin-charts-per-day")
              }
              table={{
                columns: [t("date"), t("admin-analytics-revenue")],
                rows: revenueSeries.map((p) => [p.label, money.full(p.value)]),
              }}
              title={t("admin-charts-revenue-title")}
            >
              <TimeLineChart
                data={revenueSeries}
                format={money.axis}
                seriesName={t("admin-analytics-revenue")}
              />
            </ChartCard>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* ── Top products ─────────────────────────────────────────── */}
              <ChartCard
                className="lg:col-span-2"
                empty={topProducts.length === 0}
                emptyText={t("admin-analytics-top-products-empty")}
                subtitle={t("admin-charts-top-products-subtitle")}
                table={{
                  columns: [
                    t("admin-analytics-top-products"),
                    t("admin-analytics-units"),
                    t("admin-analytics-revenue"),
                  ],
                  rows: topProducts.map((p) => [
                    p.label,
                    p.value,
                    money.full(p.revenue),
                  ]),
                }}
                title={t("admin-analytics-top-products")}
              >
                <RankedBarChart
                  data={topProducts}
                  seriesName={t("admin-analytics-units")}
                />
              </ChartCard>

              {/* ── Orders by source ─────────────────────────────────────── */}
              <ChartCard
                empty={sources.length === 0}
                emptyText={t("admin-charts-no-orders")}
                subtitle={t("admin-charts-source-subtitle")}
                table={{
                  columns: [
                    t("admin-charts-source"),
                    t("admin-analytics-orders"),
                  ],
                  rows: sources.map((s) => [s.label, s.value]),
                }}
                title={t("admin-charts-source-title")}
              >
                <ShareDonut data={sources} />
              </ChartCard>

              {/* ── Units by category ────────────────────────────────────── */}
              <ChartCard
                empty={categories.length === 0}
                emptyText={t("admin-charts-no-sales")}
                subtitle={t("admin-charts-category-subtitle")}
                table={{
                  columns: [t("categories"), t("admin-analytics-units")],
                  rows: categories.map((s) => [s.label, s.value]),
                }}
                title={t("admin-charts-category-title")}
              >
                <ShareDonut data={categories} />
              </ChartCard>
            </div>

            {/* ── Orders by status ──────────────────────────────────────── */}
            <Card>
              <Card.Content className="p-4">
                <h2 className="font-semibold mb-3">
                  {t("admin-analytics-orders-by-status")}
                </h2>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-2">
                  {data.orders_by_status.map((s) => (
                    <div key={s.status} className="text-center">
                      <p className="text-2xl font-bold">{s.count}</p>
                      <p className="text-xs text-default-400">{s.status}</p>
                    </div>
                  ))}
                </div>
              </Card.Content>
            </Card>
          </>
        )}

        {/* ── Cache Performance ────────────────────────────────────────── */}
        <h2 className="text-xl font-semibold">
          {t("admin-analytics-cache-title")}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* KV Cache */}
          <Card>
            <Card.Content className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Database className="text-primary" size={22} />
                <h3 className="font-semibold">
                  {t("admin-analytics-cache-kv")}
                </h3>
              </div>
              {cacheStats ? (
                <>
                  <div>
                    <div className="flex justify-between text-xs text-default-400 mb-1">
                      <span>{t("admin-analytics-cache-hit-rate")}</span>
                      <span
                        className={`font-semibold ${
                          cacheStats.kv.hit_rate >= 0.8
                            ? "text-success"
                            : cacheStats.kv.hit_rate >= 0.5
                              ? "text-warning"
                              : "text-danger"
                        }`}
                      >
                        {Math.round(cacheStats.kv.hit_rate * 100)}%
                      </span>
                    </div>
                    <div className="w-full bg-default-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          cacheStats.kv.hit_rate >= 0.8
                            ? "bg-success"
                            : cacheStats.kv.hit_rate >= 0.5
                              ? "bg-warning"
                              : "bg-danger"
                        }`}
                        style={{
                          width: `${Math.round(cacheStats.kv.hit_rate * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 text-center gap-2">
                    <div>
                      <p className="text-lg font-bold text-success">
                        {cacheStats.kv.hits}
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-hits")}
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-danger">
                        {cacheStats.kv.misses}
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-misses")}
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold">
                        {cacheStats.kv.entries}
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-entries")}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 text-center gap-2 pt-2 border-t border-default-200">
                    <div>
                      <p className="text-sm font-semibold">
                        {cacheStats.kv.search_ttl_seconds}s
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-search-ttl")}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">
                        {cacheStats.kv.reviews_ttl_seconds}s
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-reviews-ttl")}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">
                        {cacheStats.kv.default_ttl_seconds}s
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-default-ttl")}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-default-400 text-right">
                    {t("admin-analytics-cache-do-saved")} :{" "}
                    <span className="font-semibold text-foreground">
                      {cacheStats.kv.hits}
                    </span>
                  </p>
                </>
              ) : (
                <p className="text-sm text-default-400">
                  {t("admin-analytics-loading")}
                </p>
              )}
            </Card.Content>
          </Card>

          {/* CDN Cache */}
          <Card>
            <Card.Content className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Cloud className="text-secondary" size={22} />
                <h3 className="font-semibold">
                  {t("admin-analytics-cache-cdn")}
                </h3>
              </div>
              {cacheStats ? (
                <>
                  <div>
                    <div className="flex justify-between text-xs text-default-400 mb-1">
                      <span>{t("admin-analytics-cache-hit-rate")}</span>
                      <span
                        className={`font-semibold ${
                          cacheStats.cdn.hit_rate >= 0.8
                            ? "text-success"
                            : cacheStats.cdn.hit_rate >= 0.5
                              ? "text-warning"
                              : "text-danger"
                        }`}
                      >
                        {Math.round(cacheStats.cdn.hit_rate * 100)}%
                      </span>
                    </div>
                    <div className="w-full bg-default-100 rounded-full h-2.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          cacheStats.cdn.hit_rate >= 0.8
                            ? "bg-success"
                            : cacheStats.cdn.hit_rate >= 0.5
                              ? "bg-warning"
                              : "bg-danger"
                        }`}
                        style={{
                          width: `${Math.round(cacheStats.cdn.hit_rate * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 text-center gap-2">
                    <div>
                      <p className="text-lg font-bold text-success">
                        {cacheStats.cdn.hits}
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-hits")}
                      </p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-danger">
                        {cacheStats.cdn.misses}
                      </p>
                      <p className="text-xs text-default-400">
                        {t("admin-analytics-cache-misses")}
                      </p>
                    </div>
                  </div>
                  <p className="text-xs text-default-400 italic">
                    {t("admin-analytics-cache-cdn-note")}
                  </p>
                </>
              ) : (
                <p className="text-sm text-default-400">
                  {t("admin-analytics-loading")}
                </p>
              )}
            </Card.Content>
          </Card>
        </div>
      </div>
    </>
  );
}
