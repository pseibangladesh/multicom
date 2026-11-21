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

import type React from "react";

import { Link } from "@heroui/react";
import { Trans, useTranslation } from "react-i18next";
import { useEffect, useState, useCallback } from "react";
import { Link as RouterLink } from "react-router-dom";

import { getBaseURL } from "@/utils/base-url";
import { Navbar } from "@/components/navbar";
import { CartDrawer } from "@/components/cart-drawer";
import { useCartDrawer } from "@/contexts/cart-drawer-context";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";
import { UserTechnicalInfoModal } from "@/shared/ui/user-technical-info";
import { LoginLogoutLink } from "@/authentication";
import { siteConfig } from "@/config/site";
import {
  TwitterIcon,
  GithubIcon,
  DiscordIcon,
  Logo,
} from "@/shared/ui/icons";

export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { isOpen: isCartOpen, open: openCart, close: closeCart } = useCartDrawer();

  // Fetch session data from Better Auth backend
  const [user, setUser] = useState<any>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const checkSession = useCallback(async () => {
    try {
      const apiBase = getBaseURL() || "";
      const resp = await fetch(`${apiBase}/api/auth/session`);
      const data = await resp.json();

      if (data.session?.user) {
        setUser(data.session.user);
        // Store a placeholder token for the modal
        setAccessToken("session");
      } else {
        setUser(null);
        setAccessToken(null);
      }
    } catch (err) {
      console.error("[Auth] Session check failed:", err);
      setUser(null);
      setAccessToken(null);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <div className="relative flex flex-col h-screen">
      <Navbar onCartOpen={openCart} />
      <CartDrawer isOpen={isCartOpen} onClose={(v) => { if (!v) closeCart(); }} />
      <main className="container mx-auto max-w-7xl px-6 grow pt-16">
        {children}
      </main>
      <footer className="w-full bg-default-50 border-t border-separator mt-auto">
        {/* ── Main footer grid ──────────────────────────────────────── */}
        <div className="container mx-auto max-w-7xl px-6 py-12">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-8">

            {/* Brand + Newsletter — 2 cols on large screens */}
            <div className="lg:col-span-2 space-y-4">
              <RouterLink to="/" className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity">
                <Logo />
                <span className="font-bold text-lg text-foreground">Fufuni</span>
              </RouterLink>
              <p className="text-sm text-default-500 max-w-xs leading-relaxed">
                {t("make-beautiful-websites-regardless-of-your-design-experience")}
              </p>

              {/* Newsletter */}
              <div className="space-y-2 pt-2">
                <p className="text-sm font-semibold text-foreground">{t("footer-newsletter-title")}</p>
                <p className="text-xs text-default-400">{t("footer-newsletter-description")}</p>
                <div className="flex gap-2 max-w-xs">
                  <input
                    type="email"
                    placeholder={t("footer-newsletter-placeholder")}
                    className="flex-1 text-sm border border-separator rounded-lg px-3 py-2 bg-background text-foreground placeholder:text-default-400 focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <button
                    type="button"
                    className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
                  >
                    {t("footer-newsletter-subscribe")}
                  </button>
                </div>
              </div>
            </div>

            {/* Company */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("footer-company")}</h3>
              <ul className="space-y-2">
                {
                  [
                    { key: "footer-about",   href: "/pages/about" },
                    { key: "footer-blog",    href: "/pages/blog" },
                    { key: "footer-careers", href: "/pages/careers" },
                    { key: "footer-press",   href: "/pages/press" },
                  ].map(({ key, href }) => (
                    <li key={key}>
                      <RouterLink
                        to={href}
                        className="text-sm text-default-500 hover:text-foreground transition-colors"
                      >
                        {t(key)}
                      </RouterLink>
                    </li>
                  ))}
              </ul>
            </div>

            {/* Help */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("footer-help")}</h3>
              <ul className="space-y-2">
                {
                  [
                    { key: "footer-contact",  href: "/pages/contact" },
                    { key: "footer-faq",      href: "/pages/faq" },
                    { key: "footer-shipping", href: "/pages/shipping-policy" },
                    { key: "footer-returns",  href: "/pages/returns-policy" },
                  ].map(({ key, href }) => (
                    <li key={key}>
                      <RouterLink
                        to={href}
                        className="text-sm text-default-500 hover:text-foreground transition-colors"
                      >
                        {t(key)}
                      </RouterLink>
                    </li>
                  ))}
              </ul>
            </div>

            {/* Legal */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{t("footer-legal")}</h3>
              <ul className="space-y-2">
                {
                  [
                    { key: "footer-privacy",        href: "/pages/privacy-policy" },
                    { key: "footer-terms",          href: "/pages/terms-of-service" },
                    { key: "footer-cookies",        href: "/pages/cookie-policy" },
                    { key: "footer-legal-mentions", href: "/pages/legal-mentions" },
                  ].map(({ key, href }) => (
                    <li key={key}>
                      <RouterLink
                        to={href}
                        className="text-sm text-default-500 hover:text-foreground transition-colors"
                      >
                        {t(key)}
                      </RouterLink>
                    </li>
                  ))}
              </ul>
            </div>
          </div>

          {/* Social links row */}
          <div className="mt-8 pt-6 border-t border-separator flex flex-wrap items-center gap-4">
            <span className="text-sm font-semibold text-foreground">{t("footer-follow-us")}</span>
            <div className="flex gap-4">
              <a
                href={siteConfig().links.twitter}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Twitter"
                className="text-default-400 hover:text-foreground transition-colors"
              >
                <TwitterIcon className="w-5 h-5" />
              </a>
              <a
                href={siteConfig().links.discord}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Discord"
                className="text-default-400 hover:text-foreground transition-colors"
              >
                <DiscordIcon className="w-5 h-5" />
              </a>
              <a
                href={siteConfig().links.github}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="text-default-400 hover:text-foreground transition-colors"
              >
                <GithubIcon className="w-5 h-5" />
              </a>
            </div>
          </div>
        </div>

        {/* ── Bottom bar ──────────────────────────────────────────────── */}
        <div className="border-t border-separator bg-default-100">
          <div className="container mx-auto max-w-7xl px-6 py-3 flex flex-wrap items-center justify-between gap-3">

            {/* Copyright + powered-by */}
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs text-default-400">
                {t("footer-copyright", { year: new Date().getFullYear() })}
              </p>
              <span className="text-default-300 hidden sm:inline">·</span>
              <Link
                target="_blank"
                className="flex items-center gap-1 text-xs text-default-400 hover:text-foreground transition-colors"
                href="https://github.com/sctg-development/fufuni"
              >
                <Trans ns="base">powered-by</Trans>
                &nbsp;
                <span className="text-primary font-medium">SCTG Fufuni</span>
              </Link>
            </div>

            {/* Payment method badges */}
            <div className="flex items-center gap-1.5" title={t("footer-payment-methods")}>
              {/* Visa */}
              <div className="h-6 px-2 bg-white border border-default-200 rounded text-[10px] font-extrabold flex items-center text-blue-800 shadow-sm select-none">
                VISA
              </div>
              {/* Mastercard */}
              <div className="h-6 w-10 bg-white border border-default-200 rounded flex items-center justify-center shadow-sm">
                <div className="relative flex items-center">
                  <div className="w-4 h-4 rounded-full bg-red-500" />
                  <div className="w-4 h-4 rounded-full bg-amber-400 -ml-2 opacity-90" />
                </div>
              </div>
              {/* PayPal */}
              {/* <div className="h-6 px-2 bg-white border border-default-200 rounded text-[10px] font-bold flex items-center text-blue-700 shadow-sm select-none">
                PayPal
              </div> */}
              {/* Stripe */}
              <div className="h-6 px-2 bg-white border border-default-200 rounded text-[10px] font-bold flex items-center text-violet-600 shadow-sm select-none">
                stripe
              </div>
              {/* Apple Pay */}
              <div className="h-6 px-2 bg-white border border-default-200 rounded text-[10px] font-semibold flex items-center text-black shadow-sm select-none tracking-tight">
                 Pay
              </div>
            </div>

            {/* User info (dev/admin) */}
            <div className="flex items-center gap-2">
              {user && (
                <button
                  onClick={() => setIsModalOpen(true)}
                  className="text-xs text-default-400 hover:text-foreground transition-colors cursor-pointer"
                >
                  {user.name}
                </button>
              )}
              <span className="text-xs text-default-400">
                <LoginLogoutLink color="foreground" size="sm" loginI18nKey="manage-store" />
              </span>
            </div>

          </div>
        </div>
      </footer>
      {user ? (
        <UserTechnicalInfoModal
          accessToken={accessToken}
          isOpen={isModalOpen}
          tokenPayload={null}
          user={user}
          onClose={() => setIsModalOpen(false)}
          onTokenRefreshed={async () => {
            setAccessToken("session");
            await checkSession();
          }}
        />
      ) : (
        <></>
      )}
      <ThemeSwitcher />
    </div>
  );
}
