/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Side menu from the Bengal mock: profile / admin / log in-out, language and
 * light/dark, then About, Blog, Contact. Built on HeroUI's Drawer (react-aria
 * modal): focus is trapped, Escape and the scrim close it, and focus returns
 * to the Menu button.
 */

import { Drawer } from "@heroui/react";
import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useLocation } from "react-router-dom";

import {
  BlogGlyph,
  CloseGlyph,
  GlobeGlyph,
  InfoGlyph,
  LoginGlyph,
  MailGlyph,
  MoonGlyph,
  PersonGlyph,
  ShieldGlyph,
} from "./icons";

import { useAuth } from "@/authentication";
import { MENU_INFO_LINKS } from "@/config/navigation";
import { useTheme } from "@/hooks/use-theme";
import { applyLanguage, availableLanguages, languageDirection } from "@/i18n";
import { getBaseURL } from "@/utils/base-url";

interface SideMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
}

const INFO_ICONS: Record<string, () => ReactElement> = {
  "menu-about": InfoGlyph,
  "menu-blog": BlogGlyph,
  "nav-contact": MailGlyph,
};

export function SideMenu({ isOpen, onClose, onLogin }: SideMenuProps) {
  const { t, i18n } = useTranslation();
  const { isAuthenticated, user, logout } = useAuth();
  const { isDark, setLightTheme, setDarkTheme } = useTheme();
  const location = useLocation();
  const isAdmin = isAuthenticated && user?.is_admin === true;
  const rtl = languageDirection(i18n.language) === "rtl";

  // Close when the route changes (link followed, back button…).
  const firstPath = useRef(location.pathname + location.search);

  useEffect(() => {
    const now = location.pathname + location.search;

    if (now !== firstPath.current) {
      firstPath.current = now;
      onClose();
    }
  }, [location.pathname, location.search, onClose]);

  const logOut = () => {
    onClose();
    void logout({
      logoutParams: {
        returnTo: new URL(
          getBaseURL() || "/",
          window.location.origin,
        ).toString(),
      },
    });
  };

  return (
    <Drawer.Backdrop
      className="bg-[var(--bx-scrim)]"
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Drawer.Content placement={rtl ? "left" : "right"}>
        <Drawer.Dialog
          aria-labelledby="bx-side-menu-title"
          className="bx-menu-panel"
          id="bx-side-menu"
        >
          <div className="bx-menu-head">
            <h2 id="bx-side-menu-title">{t("menu")}</h2>
            <button
              aria-label={t("menu-close")}
              className="bx-close-btn"
              type="button"
              onClick={onClose}
            >
              <CloseGlyph />
            </button>
          </div>

          <div className="bx-menu-body">
            <div className="bx-menu-group">
              {isAuthenticated && (user?.email || user?.name) && (
                <p className="bx-menu-user">{user?.name || user?.email}</p>
              )}
              <div className="bx-menu-links">
                {isAuthenticated && (
                  <RouterLink to="/account" onClick={onClose}>
                    <PersonGlyph />
                    <span>{t("menu-profile")}</span>
                  </RouterLink>
                )}
                {isAdmin && (
                  <RouterLink to="/admin" onClick={onClose}>
                    <ShieldGlyph />
                    <span>{t("menu-admin")}</span>
                  </RouterLink>
                )}
                {isAuthenticated ? (
                  <button
                    className="bx-menu-row"
                    type="button"
                    onClick={logOut}
                  >
                    <LoginGlyph />
                    <span>{t("log-out")}</span>
                  </button>
                ) : (
                  <button
                    className="bx-menu-row"
                    type="button"
                    onClick={() => {
                      onClose();
                      onLogin();
                    }}
                  >
                    <LoginGlyph />
                    <span>{t("log-in")}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="bx-menu-group">
              <div className="bx-menu-links">
                <div className="bx-menu-row">
                  <GlobeGlyph />
                  <label htmlFor="bx-language">{t("menu-language")}</label>
                  <select
                    id="bx-language"
                    value={i18n.language}
                    onChange={(e) => void applyLanguage(e.target.value)}
                  >
                    {availableLanguages.map((l) => (
                      <option key={l.code} lang={l.code} value={l.code}>
                        {l.nativeName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="bx-menu-row">
                  <MoonGlyph />
                  <span id="bx-mode-label">{t("menu-theme")}</span>
                  <div
                    aria-labelledby="bx-mode-label"
                    className="bx-segmented"
                    role="group"
                  >
                    <button
                      aria-pressed={!isDark}
                      type="button"
                      onClick={setLightTheme}
                    >
                      {t("mode-light")}
                    </button>
                    <button
                      aria-pressed={isDark}
                      type="button"
                      onClick={setDarkTheme}
                    >
                      {t("mode-dark")}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="bx-menu-group">
              <nav aria-label={t("menu")} className="bx-menu-links">
                {MENU_INFO_LINKS.map((l) => {
                  const Glyph = INFO_ICONS[l.key] ?? InfoGlyph;

                  return (
                    <RouterLink key={l.key} to={l.href} onClick={onClose}>
                      <Glyph />
                      <span>{t(l.key)}</span>
                    </RouterLink>
                  );
                })}
              </nav>
            </div>
          </div>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
