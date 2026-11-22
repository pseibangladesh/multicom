/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TextField, Label, Input, Card, Button } from "@heroui/react";
import { X } from "lucide-react";

import { useAuth } from "@/authentication";

const MIN_PASSWORD_LENGTH = 8; // matches emailAndPassword.minPasswordLength on the server

/**
 * Sign-in / sign-up page using Better Auth email + password.
 * POST /api/auth/sign-in/email and /api/auth/sign-up/email set an HttpOnly
 * session cookie on the merchant worker (see local-provider.tsx).
 *
 * Query params: ?mode=signup, ?email=<prefill>, ?returnTo=<path>.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAuthenticated, isLoading, signInEmail, signUpEmail } = useAuth();

  const isSignUp = searchParams.get("mode") === "signup";
  const returnTo = searchParams.get("returnTo") || "/account";

  const [name, setName] = useState("");
  const [email, setEmail] = useState(searchParams.get("email") || "");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (or just signed in) → go where the user was headed.
  useEffect(() => {
    if (!isLoading && isAuthenticated) navigate(returnTo, { replace: true });
  }, [isLoading, isAuthenticated, navigate, returnTo]);

  const switchMode = () => {
    const next = new URLSearchParams(searchParams);

    if (isSignUp) next.delete("mode");
    else next.set("mode", "signup");
    setSearchParams(next, { replace: true });
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) return setError(t("login-email-required"));
    if (!password) return setError(t("login-password-required"));
    if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
      return setError(t("login-password-min", { count: MIN_PASSWORD_LENGTH }));
    }

    setLoading(true);
    setError(null);
    try {
      if (isSignUp) {
        await signUpEmail(name.trim() || email.split("@")[0], email, password);
      } else {
        await signInEmail(email, password);
      }
      // The effect above navigates once the session is refreshed.
    } catch (err) {
      console.error("Auth error:", err);
      setError(
        err instanceof Error && err.message ? err.message : t("login-error"),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <Card.Header className="flex gap-3 flex-col justify-center">
          <div className="text-center">
            <h1 className="text-3xl font-bold">
              {isSignUp ? t("login-signup-title") : t("login-title")}
            </h1>
            <p className="text-gray-500 mt-2">
              {isSignUp ? t("login-signup-subtitle") : t("login-subtitle")}
            </p>
          </div>
        </Card.Header>

        <Card.Content className="gap-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {isSignUp && (
              <TextField name="name" className="w-full">
                <Label>{t("login-name")}</Label>
                <Input
                  autoComplete="name"
                  placeholder={t("login-enter-name")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                  fullWidth
                />
              </TextField>
            )}

            <TextField
              name="email"
              type="email"
              isRequired
              isInvalid={!!error}
              className="w-full"
            >
              <Label>{t("login-email")}</Label>
              <div className="flex items-center">
                <Input
                  autoComplete="email"
                  placeholder={t("login-enter-email")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  fullWidth
                />
                {email && (
                  <button
                    type="button"
                    onClick={() => setEmail("")}
                    className="ml-2 p-1 text-gray-400 hover:text-gray-600"
                    aria-label="Clear email"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            </TextField>

            <TextField
              name="password"
              type="password"
              isRequired
              className="w-full"
            >
              <Label>{t("login-password")}</Label>
              <Input
                autoComplete={isSignUp ? "new-password" : "current-password"}
                placeholder={t("login-enter-password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                fullWidth
              />
            </TextField>

            {error && (
              <div
                className="bg-red-50 border border-red-200 rounded-lg p-3"
                role="alert"
              >
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              className="w-full font-semibold"
              isDisabled={loading || !email || !password}
              isPending={loading}
            >
              {isSignUp ? t("login-create-account-button") : t("login-sign-in")}
            </Button>
          </form>

          <div className="pt-4 border-t text-center text-sm">
            <p className="text-gray-600 mb-2">
              {isSignUp ? t("login-have-account") : t("login-new-customer")}
            </p>
            <Button variant="tertiary" onPress={switchMode} className="w-full">
              {isSignUp ? t("login-sign-in") : t("login-signup")}
            </Button>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
