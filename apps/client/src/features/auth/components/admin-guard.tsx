import type { ReactNode } from "react";

import { Navigate, useLocation } from "react-router-dom";

import { adminAccess, loginRedirect } from "../admin-access";
import { useAuth } from "../providers/use-auth";

import { SiteLoading } from "@/shared/ui/feedback/site-loading";

/**
 * Protects admin routes:
 * - signed out → /login (returning here afterwards)
 * - signed in but not an admin (email not in ADMIN_EMAILS) → home page
 *
 * This is a UX guard only; the admin API rejects non-admin sessions anyway.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user } = useAuth();
  const location = useLocation();

  switch (adminAccess({ isLoading, isAuthenticated, user })) {
    case "loading":
      return <SiteLoading />;
    case "login":
      return (
        <Navigate
          replace
          to={loginRedirect(location.pathname + location.search)}
        />
      );
    case "forbidden":
      return <Navigate replace to="/" />;
    case "allowed":
      return <>{children}</>;
  }
}
