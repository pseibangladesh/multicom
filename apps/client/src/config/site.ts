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
 * Inferred type of the object returned by {@link siteConfig}.
 * Use this type when you need to type a variable holding the site configuration.
 */
export type SiteConfig = typeof siteConfig;

import i18next from "../i18n";

/**
 * Returns the reactive site configuration object.
 * The function is called on each render so that translated labels pick up
 * the currently-active language without requiring a page reload.
 *
 * @returns The full site configuration including name, description, nav items,
 *   nav menu items, and social links.
 *
 * @example
 * ```tsx
 * const config = siteConfig();
 * console.log(config.name); // e.g. "Bengali Exchange"
 * ```
 */
export const siteConfig = () => ({
  name: "Bengali Exchange", // brand name, not translated
  needCookieConsent: true, // Set to false if you don't need cookie consent
  description: i18next.t("footer-blurb"),
  navItems: [
    {
      label: i18next.t("home"),
      href: "/",
      adminOnly: false,
    },
    {
      label: i18next.t("dashboard"),
      href: "/admin/analytics",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-products-title"),
      href: "/admin/products",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("categories"),
      href: "/admin/categories",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-customers-title"),
      href: "/admin/customers",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-inventory-title"),
      href: "/admin/inventory",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-orders-title"),
      href: "/admin/orders",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("reviews-title"),
      href: "/admin/reviews",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-webhooks-title"),
      href: "/admin/webhooks",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-email-templates-title"),
      href: "/admin/email-templates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-regions-title"),
      href: "/admin/regions",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-currencies-title"),
      href: "/admin/currencies",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-countries-title"),
      href: "/admin/countries",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-warehouses-title"),
      href: "/admin/warehouses",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-shipping-rates-title"),
      href: "/admin/shipping-rates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-shipping-classes-title"),
      href: "/admin/shipping-classes",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-tax-rates-title"),
      href: "/admin/tax-rates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("openapi-explorer"),
      href: "/openapi",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-payment-gateways-title") || "Payment Gateways",
      href: "/admin/payment-gateways",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-marketplaces-title"),
      href: "/admin/marketplaces",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
  ],
  navMenuItems: [
    {
      label: i18next.t("home"),
      href: "/",
      adminOnly: false,
    },
    {
      label: i18next.t("admin-products-title"),
      href: "/admin/products",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("categories"),
      href: "/admin/categories",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-customers-title"),
      href: "/admin/customers",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-inventory-title"),
      href: "/admin/inventory",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-orders-title"),
      href: "/admin/orders",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-webhooks-title"),
      href: "/admin/webhooks",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-email-templates-title"),
      href: "/admin/email-templates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-regions-title"),
      href: "/admin/regions",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-currencies-title"),
      href: "/admin/currencies",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-countries-title"),
      href: "/admin/countries",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-warehouses-title"),
      href: "/admin/warehouses",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-shipping-rates-title"),
      href: "/admin/shipping-rates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-shipping-classes-title"),
      href: "/admin/shipping-classes",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-tax-rates-title"),
      href: "/admin/tax-rates",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
    {
      label: i18next.t("admin-marketplaces-title"),
      href: "/admin/marketplaces",
      adminOnly: true, // shown only to sessions with is_admin (ADMIN_EMAILS)
    },
  ],
  links: {
    github: "https://github.com/pseibangladesh/multicom",
    twitter: "https://twitter.com/hero_ui",
    docs: "https://github.com/pseibangladesh/multicom/blob/main/README.md",
    discord: "https://discord.gg/9b6yyZKmH4",
    sponsor: "https://github.com/sponsors/sctg-development",
  },
});
