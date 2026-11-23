/**
 * Admin dashboard (/admin): entry point to the main admin sections, with a
 * snapshot of recent orders and payment gateway status from the admin API.
 * Protected by <AdminGuard> in App.tsx; the API calls use the Better Auth
 * session cookie via useSecuredApi (credentials: "include").
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Card } from "@heroui/react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { formatMoney } from "@/utils/currency";

interface DashboardOrder {
  id: string;
  number?: string;
  customer_email: string;
  status: string;
  amounts: { total_cents: number; currency?: string };
  created_at: string;
}

const SECTIONS = [
  {
    to: "/admin/products",
    titleKey: "admin-products-title",
    descKey: "admin-dashboard-products-desc",
  },
  {
    to: "/admin/orders",
    titleKey: "admin-orders-title",
    descKey: "admin-dashboard-orders-desc",
  },
  {
    to: "/admin/payment-gateways",
    titleKey: "admin-payment-gateways-title",
    descKey: "admin-dashboard-payments-desc",
  },
] as const;

export default function AdminDashboardPage() {
  const { t, i18n } = useTranslation();
  const { getJson } = useSecuredApi();
  const apiBase = getApiBase();

  const orders = useQuery({
    queryKey: ["admin-dashboard", "recent-orders"],
    queryFn: async () =>
      (await getJson(`${apiBase}/v1/orders?limit=5`)) as {
        items?: DashboardOrder[];
      },
  });

  const gateways = useQuery({
    queryKey: ["admin-dashboard", "payment-gateways"],
    queryFn: async () =>
      (await getJson(`${apiBase}/v1/admin/settings/payment-gateways`)) as {
        sslcommerz?: { enabled: boolean; sandbox: boolean };
      },
  });

  const recent = orders.data?.items ?? [];
  const ssl = gateways.data?.sslcommerz;

  return (
    <>
      <div className="max-w-5xl mx-auto py-12 px-4">
        <h1 className="text-3xl font-bold mb-6">
          {t("admin-dashboard-title")}
        </h1>

        <div className="grid gap-4 sm:grid-cols-3 mb-8">
          {SECTIONS.map(({ to, titleKey, descKey }) => (
            <RouterLink key={to} className="block" to={to}>
              <Card className="h-full hover:bg-default-100 transition-colors">
                <Card.Header>
                  <h2 className="text-lg font-semibold">{t(titleKey)}</h2>
                </Card.Header>
                <Card.Content>
                  <p className="text-sm text-default-500">{t(descKey)}</p>
                  {to === "/admin/payment-gateways" && ssl && (
                    <p className="text-sm mt-2">
                      SSLCommerz:{" "}
                      {ssl.enabled
                        ? `${t("admin-dashboard-enabled")}${ssl.sandbox ? " (sandbox)" : ""}`
                        : t("admin-dashboard-disabled")}
                    </p>
                  )}
                </Card.Content>
              </Card>
            </RouterLink>
          ))}
        </div>

        <Card>
          <Card.Header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {t("admin-dashboard-recent-orders")}
            </h2>
            <RouterLink
              className="text-sm text-primary hover:underline"
              to="/admin/orders"
            >
              {t("admin-dashboard-view-all")}
            </RouterLink>
          </Card.Header>
          <Card.Content>
            {orders.isLoading && (
              <p className="text-default-500">{t("loading")}</p>
            )}
            {orders.isError && (
              <p className="text-red-500" role="alert">
                {t("admin-dashboard-load-error")}
              </p>
            )}
            {!orders.isLoading && !orders.isError && recent.length === 0 && (
              <p className="text-default-500">
                {t("admin-dashboard-no-orders")}
              </p>
            )}
            {recent.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-default-500">
                    <th className="py-2">#</th>
                    <th className="py-2">{t("admin-orders-customer")}</th>
                    <th className="py-2">{t("admin-orders-status")}</th>
                    <th className="py-2 text-right">
                      {t("admin-orders-total")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((o) => (
                    <tr key={o.id} className="border-t border-default-200">
                      <td className="py-2 font-mono">
                        {o.number ?? o.id.slice(0, 8)}
                      </td>
                      <td className="py-2">{o.customer_email}</td>
                      <td className="py-2">{o.status}</td>
                      <td className="py-2 text-right">
                        {formatMoney(
                          o.amounts.total_cents,
                          o.amounts.currency ?? "",
                          i18n.language,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card.Content>
        </Card>
      </div>
    </>
  );
}
