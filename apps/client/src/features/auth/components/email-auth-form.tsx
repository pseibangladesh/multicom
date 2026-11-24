/**
 * Email + password sign-in and account creation, used by the /login page and
 * the login modal.
 *
 * New accounts must confirm their email before they can sign in (the server
 * requires it), so creating an account ends on a "check your email" step, and
 * signing in to an unconfirmed account offers to send the link again.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label, TextField } from "@heroui/react";

import { EmailNotVerifiedError, useAuth } from "@/authentication";

/** Matches emailAndPassword.minPasswordLength on the server (lib/auth.ts). */
export const MIN_PASSWORD_LENGTH = 8;

export type AuthMode = "signin" | "signup";

interface EmailAuthFormProps {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  initialEmail?: string;
  /** Called once signed in (the session is already refreshed). */
  onSignedIn?: () => void;
}

export function EmailAuthForm({
  mode,
  onModeChange,
  initialEmail = "",
  onSignedIn,
}: EmailAuthFormProps) {
  const { t } = useTranslation();
  const { signInEmail, signUpEmail, resendVerification } = useAuth();
  const isSignUp = mode === "signup";

  const [name, setName] = useState("");
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when a confirmation link was sent (after sign-up or a refused sign-in). */
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();

    if (!address) return setError(t("login-email-required"));
    if (!password) return setError(t("login-password-required"));
    if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
      return setError(t("login-password-min", { count: MIN_PASSWORD_LENGTH }));
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (isSignUp) {
        await signUpEmail(
          name.trim() || address.split("@")[0],
          address,
          password,
        );
        setPendingEmail(address);
      } else {
        await signInEmail(address, password);
        onSignedIn?.();
      }
      setPassword("");
    } catch (err) {
      if (err instanceof EmailNotVerifiedError) {
        // The server has just emailed a fresh link.
        setPendingEmail(address);
        setNotice(t("login-email-not-verified"));
      } else {
        setError(
          err instanceof Error && err.message ? err.message : t("login-error"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!pendingEmail) return;
    setBusy(true);
    setError(null);
    try {
      await resendVerification(pendingEmail);
      setNotice(t("login-link-resent"));
    } catch (err) {
      setError(
        err instanceof Error && err.message ? err.message : t("login-error"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (pendingEmail) {
    return (
      <div className="flex w-full flex-col gap-4 text-center" role="status">
        <h2 className="font-display text-2xl text-bx-ink">
          {t("login-check-email")}
        </h2>
        <p className="text-bx-ink-soft">
          {t("login-verify-sent", { email: pendingEmail })}
        </p>
        {notice && <p className="text-sm text-bx-ink">{notice}</p>}
        {error && (
          <p className="text-sm text-red-700 dark:text-red-300" role="alert">
            {error}
          </p>
        )}
        <p className="text-sm text-bx-stone">{t("login-didnt-receive")}</p>
        <Button isPending={busy} variant="outline" onPress={resend}>
          {t("login-resend-link")}
        </Button>
        <Button
          variant="tertiary"
          onPress={() => {
            setPendingEmail(null);
            setNotice(null);
            setError(null);
            onModeChange("signin");
          }}
        >
          {t("login-try-another-email")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <form className="flex w-full flex-col gap-4" noValidate onSubmit={submit}>
        {isSignUp && (
          <TextField className="w-full" isDisabled={busy} name="name">
            <Label>{t("login-name")}</Label>
            <Input
              autoComplete="name"
              placeholder={t("login-enter-name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </TextField>
        )}

        <TextField
          className="w-full"
          isDisabled={busy}
          isRequired
          name="email"
          type="email"
        >
          <Label>{t("login-email")}</Label>
          <Input
            autoComplete="email"
            placeholder={t("login-enter-email")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </TextField>

        <TextField
          className="w-full"
          isDisabled={busy}
          isRequired
          name="password"
          type="password"
        >
          <Label>{t("login-password")}</Label>
          <Input
            autoComplete={isSignUp ? "new-password" : "current-password"}
            placeholder={t("login-enter-password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </TextField>

        {error && (
          <p
            className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            role="alert"
          >
            {error}
          </p>
        )}

        <Button
          className="w-full"
          isDisabled={!email || !password}
          isPending={busy}
          type="submit"
        >
          {isSignUp ? t("login-create-account-button") : t("login-sign-in")}
        </Button>
      </form>

      <p className="text-center text-sm text-bx-stone">
        {isSignUp ? t("login-have-account") : t("login-new-customer")}{" "}
        <button
          className="cursor-pointer font-semibold text-bx-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          type="button"
          onClick={() => {
            setError(null);
            onModeChange(isSignUp ? "signin" : "signup");
          }}
        >
          {isSignUp ? t("login-sign-in") : t("login-signup")}
        </button>
      </p>
    </div>
  );
}
