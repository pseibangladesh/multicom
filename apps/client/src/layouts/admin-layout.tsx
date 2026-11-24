/**
 * Admin area: every module in a grouped sidebar (desktop) or a collapsible
 * section list (phone), with the page in the outlet.
 */
import { Suspense, useEffect, useRef } from "react";
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
                    `flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
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
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const current = [...ADMIN_NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));

  // Close the phone menu after navigating.
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  return (
    <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Phone / tablet: collapsible list */}
      <details
        ref={detailsRef}
        className="rounded-md border border-bx-line bg-bx-surface-raised lg:hidden"
      >
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-bx-ink">
          <span>
            {t("admin-nav-label")}
            {current ? `: ${t(current.labelKey)}` : ""}
          </span>
        </summary>
        <nav
          aria-label={t("admin-nav-label")}
          className="border-t border-bx-line p-3"
        >
          <AdminNavList />
        </nav>
      </details>

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
