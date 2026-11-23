/**
 * @copyright Copyright (c) 2024-2026 Ronan LE MEILLAT
 * @license AGPL-3.0-or-later
 */

import type { FC } from "react";

import { Navigate, useLocation } from "react-router-dom";

import { loginRedirect } from "../admin-access";
import { useAuth } from "../providers/use-auth";

import { ContentLoading } from "@/shared/ui/feedback/content-loading";

/**
 * Renders `component` for signed-in users; sends everyone else to /login,
 * coming back here afterwards.
 *
 * @example
 * <AuthenticationGuard component={AccountLayout} />
 */
export const AuthenticationGuard: FC<{ component: FC }> = ({
  component: Component,
}) => {
  const { isLoading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (isLoading) return <ContentLoading />;
  if (!isAuthenticated) {
    return (
      <Navigate
        replace
        to={loginRedirect(location.pathname + location.search)}
      />
    );
  }

  return <Component />;
};

/**
 * JSON helpers that send the session cookie, plus the permission check.
 *
 * @example
 * const { getJson, postJson } = useSecuredApi();
 * const data = await getJson(`${apiBase}/v1/me/profile`);
 */
export const useSecuredApi = () => {
  const {
    getJson,
    postJson,
    postForm,
    deleteJson,
    isAdmin,
    putJson,
    patchJson,
  } = useAuth();

  return {
    getJson,
    postJson,
    postForm,
    patchJson,
    deleteJson,
    isAdmin,
    putJson,
  };
};
