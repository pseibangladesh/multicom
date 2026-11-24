/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Storefront navigation: header, side menu and footer links. Labels are i18n
 * keys (translated where rendered). Only pages that exist are linked: app
 * routes below, or CMS pages defined in config/cms-content.ts.
 */

import { CMS_CONTENT } from "@/config/cms-content";

export type NavLink = { key: string; href: string; external?: boolean };

export const PRIMARY_NAV: NavLink[] = [
  { key: "nav-shop", href: "/" },
  { key: "nav-categories", href: "/products" },
  { key: "nav-checkout", href: "/cart" },
  { key: "nav-contact", href: "/pages/contact" },
];

export const MENU_INFO_LINKS: NavLink[] = [
  { key: "menu-about", href: "/pages/about" },
  { key: "menu-blog", href: "/pages/blog" },
  { key: "nav-contact", href: "/pages/contact" },
];

export const FOOTER_COLUMNS: { titleKey: string; links: NavLink[] }[] = [
  {
    titleKey: "footer-company",
    links: [
      { key: "footer-about", href: "/pages/about" },
      { key: "footer-blog", href: "/pages/blog" },
      { key: "footer-careers", href: "/pages/careers" },
      { key: "footer-press", href: "/pages/press" },
    ],
  },
  {
    titleKey: "footer-help",
    links: [
      { key: "footer-contact", href: "/pages/contact" },
      { key: "footer-faq", href: "/pages/faq" },
      { key: "footer-shipping", href: "/pages/shipping-policy" },
      { key: "footer-returns", href: "/pages/returns-policy" },
    ],
  },
  {
    titleKey: "footer-legal",
    links: [
      { key: "footer-privacy", href: "/pages/privacy-policy" },
      { key: "footer-terms", href: "/pages/terms-of-service" },
      { key: "footer-cookies", href: "/pages/cookie-policy" },
      { key: "footer-legal-mentions", href: "/pages/legal-mentions" },
    ],
  },
];

/** Only the project's own accounts. */
export const SOCIAL_LINKS: NavLink[] = [
  {
    key: "github",
    href: "https://github.com/pseibangladesh/multicom",
    external: true,
  },
];

const APP_ROUTES = new Set([
  "/",
  "/products",
  "/cart",
  "/account",
  "/admin",
  "/login",
]);

export function isKnownPath(href: string): boolean {
  if (APP_ROUTES.has(href)) return true;
  const m = /^\/pages\/([a-z0-9-]+)$/.exec(href);

  return m !== null && Object.prototype.hasOwnProperty.call(CMS_CONTENT, m[1]);
}

export function visibleLinks(links: NavLink[]): NavLink[] {
  return links.filter((l) => l.external || isKnownPath(l.href));
}
