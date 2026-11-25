/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Storefront footer from the Bengal mock: brand + blurb, links to pages that
 * exist, social, payment badges for gateways that are on, copyright.
 * The newsletter form is hidden until it has a backend.
 */

import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";

import { BrandMark } from "./brand-mark";

import { useAuth } from "@/authentication";
import { FOOTER_COLUMNS, visibleLinks } from "@/config/navigation";
import { paymentBadges } from "@/lib/payment-badges";
import { useSocialLinks } from "@/lib/site-content";
import { enabledPaymentMethods, getPaymentMethods } from "@/lib/store-api";
import { SOCIAL_PLATFORM_LABELS, SocialIcon } from "@/shared/ui/social-icons";

export function SiteFooter() {
  const { t } = useTranslation();
  const { user, isAuthenticated } = useAuth();
  const { data: methods, isPending: paymentsLoading } = useQuery({
    queryKey: ["payment-methods"],
    queryFn: getPaymentMethods,
    staleTime: 5 * 60_000,
    retry: 1, // decoration only: settle quickly if the endpoint is down
  });
  const badges = methods ? paymentBadges(enabledPaymentMethods(methods)) : [];
  // Admin → Social links. Nothing until loaded, so a removed link never flashes.
  const { data: socialLinks = [] } = useSocialLinks();

  return (
    <footer className="bx-footer">
      <div className="bx-wrap">
        <div className="bx-footer-grid">
          <div className="bx-footer-brand">
            <BrandMark />
            <p>{t("footer-blurb")}</p>
          </div>

          {FOOTER_COLUMNS.map((col) => {
            const links = visibleLinks(col.links);

            if (links.length === 0) return null;

            return (
              <div key={col.titleKey} className="bx-footer-col">
                <h2>{t(col.titleKey)}</h2>
                <ul>
                  {links.map((l) => (
                    <li key={l.href}>
                      <RouterLink to={l.href}>{t(l.key)}</RouterLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="bx-footer-bottom">
          <div className="bx-left">
            <span>
              {t("footer-copyright", { year: new Date().getFullYear() })}
            </span>
            <span aria-hidden="true" className="bx-dot">
              ·
            </span>
            <a
              href="https://github.com/pseibangladesh/multicom"
              rel="noopener noreferrer"
              target="_blank"
            >
              <Trans ns="base">powered-by</Trans> SCTG Bengali Exchange
            </a>
            {isAuthenticated && user?.name && (
              <>
                <span aria-hidden="true" className="bx-dot">
                  ·
                </span>
                <RouterLink className="hover:text-bx-primary" to="/account">
                  {user.name}
                </RouterLink>
              </>
            )}
          </div>

          {socialLinks.length > 0 && (
            <ul aria-label={t("footer-social")} className="bx-social">
              {socialLinks.map((l, i) => {
                const label = SOCIAL_PLATFORM_LABELS[l.platform] ?? l.platform;

                return (
                  <li key={`${l.platform}-${i}`}>
                    <a
                      aria-label={label}
                      href={l.url}
                      rel="noopener noreferrer"
                      target="_blank"
                      title={label}
                    >
                      <SocialIcon platform={l.platform} />
                    </a>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Loading: a quiet placeholder in the reserved space. Loaded: the
              list only when a gateway is on (none or an error shows nothing). */}
          {paymentsLoading ? (
            <div aria-hidden="true" className="bx-pay bx-pay-placeholder">
              <span />
              <span />
              <span />
            </div>
          ) : (
            badges.length > 0 && (
              <div
                aria-label={t("footer-payment-methods")}
                className="bx-pay"
                role="list"
              >
                {badges.map((b) => (
                  <span key={b} role="listitem">
                    {b}
                  </span>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </footer>
  );
}
