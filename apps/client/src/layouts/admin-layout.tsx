/**
 * Admin area: every module in a grouped sidebar (desktop) or a slide-in
 * drawer behind a hamburger button (phone / tablet), with the page in the
 * outlet.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { ADMIN_NAV, ADMIN_NAV_ITEMS } from "@/config/admin-nav";
import { ContentLoading } from "@/shared/ui/feedback/content-loading";

function AdminNavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-5">
      {ADMIN_NAV.map((group) => (
        <div key={group.labelKey}>
          <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-bx-stone">
            {t(group.labelKey)}
          </p>
          <ul className="flex flex-col">
            {group.items.map(({ href, icon: Icon, labelKey }) => (
              <li key={href}>
                <NavLink
                  className={({ isActive }) =>
                    `bx-tap flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                      isActive
                        ? "bg-bx-indigo-tint font-medium text-bx-primary"
                        : "text-bx-ink-soft hover:bg-bx-paper hover:text-bx-ink"
                    }`
                  }
                  end={href === "/admin"}
                  to={href}
                  onClick={onNavigate}
                >
                  <Icon aria-hidden className="h-4 w-4 shrink-0" />
                  <span>{t(labelKey)}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function AdminLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const current = [...ADMIN_NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));

  // Close the drawer after navigating.
  useEffect(() => setMenuOpen(false), [pathname]);

  // While open: Escape closes, the page behind doesn't scroll, focus moves
  // into the drawer and back to the hamburger on close.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    const overflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      menuButtonRef.current?.focus();
    };
  }, [menuOpen]);

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Phone / tablet: hamburger + drawer */}
      <div className="flex items-center gap-3 lg:hidden">
        <button
          ref={menuButtonRef}
          aria-controls="admin-drawer"
          aria-expanded={menuOpen}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-bx-line bg-bx-surface-raised px-3 text-sm font-medium text-bx-ink hover:border-bx-primary"
          type="button"
          onClick={() => setMenuOpen(true)}
        >
          <Menu aria-hidden className="h-5 w-5" />
          {t("admin-nav-label")}
        </button>
        {current && (
          <span className="min-w-0 truncate text-sm text-bx-stone">
            {t(current.labelKey)}
          </span>
        )}
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            aria-label={t("admin-nav-close")}
            className="absolute inset-0 bg-black/50"
            tabIndex={-1}
            type="button"
            onClick={() => setMenuOpen(false)}
          />
          <div
            aria-label={t("admin-nav-label")}
            aria-modal="true"
            className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-bx-line bg-bx-surface-raised shadow-xl"
            id="admin-drawer"
            role="dialog"
          >
            <div className="flex items-center justify-between border-b border-bx-line px-4 py-3">
              <span className="font-semibold text-bx-ink">
                {t("admin-nav-label")}
              </span>
              <button
                ref={closeButtonRef}
                aria-label={t("admin-nav-close")}
                className="grid h-9 w-9 place-items-center rounded-md text-bx-stone hover:bg-bx-paper hover:text-bx-ink"
                type="button"
                onClick={() => setMenuOpen(false)}
              >
                <X aria-hidden className="h-5 w-5" />
              </button>
            </div>
            <nav
              aria-label={t("admin-nav-label")}
              className="flex-1 overflow-y-auto p-3"
            >
              <AdminNavList onNavigate={() => setMenuOpen(false)} />
            </nav>
          </div>
        </div>
      )}

      {/* Desktop: sidebar */}
      <aside className="hidden lg:block">
        <nav
          aria-label={t("admin-nav-label")}
          className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-md border border-bx-line bg-bx-surface-raised p-3"
        >
          <AdminNavList />
        </nav>
      </aside>

      <div className="min-w-0">
        <Suspense fallback={<ContentLoading />}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
