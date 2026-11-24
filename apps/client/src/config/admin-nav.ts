/**
 * Every admin module, grouped. One list feeds the admin sidebar and the
 * dashboard so a page can't exist without a way to reach it
 * (admin-nav.test.ts checks this against the routes in app.tsx).
 */
import type { LucideIcon } from "lucide-react";

import {
  BarChart3,
  Bot,
  Boxes,
  CreditCard,
  FileCode2,
  FolderTree,
  Globe2,
  Image,
  KeyRound,
  Languages,
  LayoutDashboard,
  Mail,
  MapPinned,
  Package,
  Percent,
  Receipt,
  Star,
  Store,
  Truck,
  Users,
  UserCog,
  Warehouse,
  Webhook,
  Coins,
  Tags,
} from "lucide-react";

export interface AdminNavItem {
  /** i18n key for the label. */
  labelKey: string;
  href: string;
  icon: LucideIcon;
}

export interface AdminNavGroup {
  labelKey: string;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    labelKey: "admin-nav-overview",
    items: [
      {
        labelKey: "admin-nav-dashboard",
        href: "/admin",
        icon: LayoutDashboard,
      },
      {
        labelKey: "admin-analytics-title",
        href: "/admin/analytics",
        icon: BarChart3,
      },
    ],
  },
  {
    labelKey: "admin-nav-catalogue",
    items: [
      {
        labelKey: "admin-products-title",
        href: "/admin/products",
        icon: Package,
      },
      { labelKey: "categories", href: "/admin/categories", icon: FolderTree },
      {
        labelKey: "admin-inventory-title",
        href: "/admin/inventory",
        icon: Boxes,
      },
      { labelKey: "admin-banners-title", href: "/admin/banners", icon: Image },
      { labelKey: "reviews-title", href: "/admin/reviews", icon: Star },
    ],
  },
  {
    labelKey: "admin-nav-sales",
    items: [
      { labelKey: "admin-orders-title", href: "/admin/orders", icon: Receipt },
      {
        labelKey: "admin-customers-title",
        href: "/admin/customers",
        icon: Users,
      },
    ],
  },
  {
    labelKey: "admin-nav-shipping",
    items: [
      { labelKey: "admin-regions-title", href: "/admin/regions", icon: Globe2 },
      {
        labelKey: "admin-countries-title",
        href: "/admin/countries",
        icon: MapPinned,
      },
      {
        labelKey: "admin-currencies-title",
        href: "/admin/currencies",
        icon: Coins,
      },
      {
        labelKey: "admin-warehouses-title",
        href: "/admin/warehouses",
        icon: Warehouse,
      },
      {
        labelKey: "admin-shipping-rates-title",
        href: "/admin/shipping-rates",
        icon: Truck,
      },
      {
        labelKey: "admin-shipping-classes-title",
        href: "/admin/shipping-classes",
        icon: Tags,
      },
      {
        labelKey: "admin-tax-rates-title",
        href: "/admin/tax-rates",
        icon: Percent,
      },
    ],
  },
  {
    labelKey: "admin-nav-channels",
    items: [
      {
        labelKey: "admin-marketplaces-title",
        href: "/admin/marketplaces",
        icon: Store,
      },
      {
        labelKey: "admin-ai-agents-title",
        href: "/admin/ai-agents",
        icon: Bot,
      },
      {
        labelKey: "admin-webhooks-title",
        href: "/admin/webhooks",
        icon: Webhook,
      },
    ],
  },
  {
    labelKey: "admin-nav-settings",
    items: [
      {
        labelKey: "admin-payment-gateways-title",
        href: "/admin/payment-gateways",
        icon: CreditCard,
      },
      {
        labelKey: "admin-email-templates-title",
        href: "/admin/email-templates",
        icon: Mail,
      },
      {
        labelKey: "admin-languages-title",
        href: "/admin/languages",
        icon: Languages,
      },
      {
        labelKey: "admin-api-keys-title",
        href: "/admin/api-keys",
        icon: KeyRound,
      },
      {
        labelKey: "admin-users-page-title",
        href: "/admin/users",
        icon: UserCog,
      },
      { labelKey: "openapi-explorer", href: "/openapi", icon: FileCode2 },
    ],
  },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap(
  (g) => g.items,
);
