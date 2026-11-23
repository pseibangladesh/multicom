/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "@heroui/react";

import { useAuth } from "@/authentication";
import {
  EmailAuthForm,
  type AuthMode,
} from "@/features/auth/components/email-auth-form";
import { ContentLoading } from "@/shared/ui/feedback/content-loading";

/**
 * Sign-in / create-account page (Better Auth email + password).
 *
 * Query parameters:
 * - `mode=signup` opens "create account";
 * - `email` prefills the address;
 * - `returnTo` is where to go once signed in (default: the account page);
 * - `verified=1` / `error=…` are added when the emailed confirmation link
 *   brings the user back here (signed in on success).
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated, isLoading } = useAuth();

  const mode: AuthMode =
    searchParams.get("mode") === "signup" ? "signup" : "signin";
  const returnTo = searchParams.get("returnTo") || "/account";
  const linkFailed = !!searchParams.get("error");

  // Signed in (already, after the form, or by the confirmation link) → continue.
  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate(returnTo, { replace: true });
  }, [isLoading, isAuthenticated, navigate, returnTo]);

  const setMode = (next: AuthMode) => {
    const params = new URLSearchParams(searchParams);

    if (next === "signup") params.set("mode", "signup");
    else params.delete("mode");
    params.delete("error");
    setSearchParams(params, { replace: true });
  };

  // Until the session is known, don't flash the form at a signed-in visitor.
  if (isLoading || isAuthenticated) {
    return (
      <div className="min-h-dvh bg-bx-paper">
        <ContentLoading />
      </div>
    );
  }

  const isSignUp = mode === "signup";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bx-paper p-4 text-bx-ink">
      <Card className="w-full max-w-md border border-bx-line bg-bx-surface-raised shadow-none">
        <Card.Header className="flex flex-col justify-center gap-3">
          <div className="text-center">
            <h1 className="font-display text-3xl text-bx-ink">
              {isSignUp ? t("login-signup-title") : t("login-title")}
            </h1>
            <p className="mt-2 text-bx-stone">
              {isSignUp ? t("login-signup-subtitle") : t("login-subtitle")}
            </p>
          </div>
        </Card.Header>

        <Card.Content className="gap-6">
          {linkFailed && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              role="alert"
            >
              {t("login-verify-failed")}
            </p>
          )}
          <EmailAuthForm
            initialEmail={searchParams.get("email") || ""}
            mode={mode}
            onModeChange={setMode}
          />
        </Card.Content>
      </Card>
    </div>
  );
}
