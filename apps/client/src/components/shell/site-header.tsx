/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Storefront header from the Bengal mock: wordmark · centre nav + search ·
 * mobile cart and the Menu pill. Below 960px the centre nav hides and a
 * full-width search row appears (see styles/shell.css).
 */

import { forwardRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { NavLink as RouterNavLink, useNavigate } from "react-router-dom";

import { BrandMark } from "./brand-mark";
import { CartGlyph, PersonGlyph, SearchGlyph } from "./icons";

import { useAuth } from "@/authentication";
import { PRIMARY_NAV } from "@/config/navigation";
import { useCart } from "@/hooks/use-cart";

interface SiteHeaderProps {
  onOpenMenu: () => void;
  onOpenCart: () => void;
  menuOpen: boolean;
}

function SearchBox({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();

    if (q) {
      navigate(`/?q=${encodeURIComponent(q)}`);
      setValue("");
    }
  };

  return (
    <form className="bx-search" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={id}>
        {t("search-products")}
      </label>
      <SearchGlyph />
      <input
        autoComplete="off"
        id={id}
        placeholder={t(
          "search-placeholder",
        )} /* short: fits the 12rem box; the label keeps the full text */
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}

export const SiteHeader = forwardRef<HTMLButtonElement, SiteHeaderProps>(
  function SiteHeader({ onOpenMenu, onOpenCart, menuOpen }, menuButtonRef) {
    const { t } = useTranslation();
    const { count } = useCart();
    const { isAuthenticated, user } = useAuth();
    const initial = isAuthenticated
      ? (user?.name || user?.email || "").trim().charAt(0).toUpperCase()
      : "";
    const [shop, categories, checkout, contact] = PRIMARY_NAV;
    const navLink = (l: (typeof PRIMARY_NAV)[number]) => (
      <RouterNavLink key={l.key} end to={l.href}>
        {t(l.key)}
      </RouterNavLink>
    );

    return (
      <header className="bx-header">
        <a className="bx-skip-link" href="#main">
          {t("skip-to-content")}
        </a>
        <div className="bx-wrap">
          <div className="bx-bar">
            <BrandMark />

            <nav aria-label={t("nav-primary")} className="bx-center-nav">
              {navLink(shop)}
              {navLink(categories)}
              <button
                className="bx-cart-link"
                type="button"
                onClick={onOpenCart}
              >
                <span>{t("nav-cart")}</span>
                <span aria-hidden="true" className="bx-badge">
                  {count}
                </span>
                <span className="sr-only">({count})</span>
              </button>
              {navLink(checkout)}
              {navLink(contact)}
              <SearchBox id="bx-search-desktop" />
            </nav>

            <div className="bx-header-end">
              <button
                className="bx-mobile-cart"
                type="button"
                onClick={onOpenCart}
              >
                <CartGlyph />
                {/* Named by text, not aria-label, so the visible badge matches the name. */}
                <span className="sr-only">
                  {t("nav-cart")} ({count})
                </span>
                {count > 0 && (
                  <span aria-hidden="true" className="bx-badge">
                    {count}
                  </span>
                )}
              </button>
              <button
                ref={menuButtonRef}
                aria-controls={menuOpen ? "bx-side-menu" : undefined}
                aria-expanded={menuOpen}
                aria-haspopup="dialog"
                className="bx-menu-btn"
                type="button"
                onClick={onOpenMenu}
              >
                <span aria-hidden="true" className="bx-lines">
                  <span />
                  <span />
                </span>
                <span className="bx-menu-label">{t("menu")}</span>
                <span aria-hidden="true" className="bx-avatar">
                  {isAuthenticated && user?.image ? (
                    <img
                      alt=""
                      className="h-full w-full rounded-full object-cover"
                      src={user.image}
                    />
                  ) : (
                    initial || <PersonGlyph />
                  )}
                </span>
              </button>
            </div>
          </div>

          <div className="bx-mobile-search">
            <SearchBox id="bx-search-mobile" />
          </div>
        </div>
      </header>
    );
  },
);
