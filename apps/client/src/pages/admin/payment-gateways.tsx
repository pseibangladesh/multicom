/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, Input, Switch, Label, Tooltip } from "@heroui/react";
import DefaultLayout from "@/layouts/default";
import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";

interface SslcommerzConfig {
  enabled: boolean;
  store_id: string;
  sandbox: boolean;
}

type KeySource = "dashboard" | "environment" | "legacy" | "none";

/** GET /v1/admin/settings/payment-gateways → stripe. Secrets are never returned. */
interface StripeConfig {
  enabled: boolean;
  active: boolean;
  mode: "test" | "live" | null;
  publishable_key: string;
  secret_key_set: boolean;
  secret_key_last4: string | null;
  secret_key_source: KeySource;
  webhook_secret_set: boolean;
  webhook_secret_source: KeySource;
  webhook_url: string;
}

const EMPTY_STRIPE: StripeConfig = {
  enabled: false,
  active: false,
  mode: null,
  publishable_key: "",
  secret_key_set: false,
  secret_key_last4: null,
  secret_key_source: "none",
  webhook_secret_set: false,
  webhook_secret_source: "none",
  webhook_url: "",
};

export default function PaymentGatewaysPage() {
  const { t } = useTranslation();
  const { getJson, putJson } = useSecuredApi();
  const apiBase = getApiBase();

  const [config, setConfig] = useState<SslcommerzConfig>({
    enabled: false,
    store_id: "",
    sandbox: true,
  });
  const [storePassword, setStorePassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const [stripe, setStripe] = useState<StripeConfig>(EMPTY_STRIPE);
  const [stripeSecretKey, setStripeSecretKey] = useState("");
  const [stripeWebhookSecret, setStripeWebhookSecret] = useState("");
  const [isSavingStripe, setIsSavingStripe] = useState(false);
  const [stripeMessage, setStripeMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const loadData = async () => {
    try {
      const resp = await getJson(`${apiBase}/v1/admin/settings/payment-gateways`);
      if (resp?.sslcommerz) {
        setConfig(resp.sslcommerz);
      }
      if (resp?.stripe) {
        setStripe({ ...EMPTY_STRIPE, ...resp.stripe });
      }
    } catch (err) {
      console.error("Failed to load payment gateway settings", err);
    }
  };

  const handleSaveStripe = async () => {
    setIsSavingStripe(true);
    setStripeMessage(null);
    try {
      const resp = await putJson(`${apiBase}/v1/admin/settings/payment-gateways/stripe`, {
        enabled: stripe.enabled,
        publishable_key: stripe.publishable_key.trim(),
        secret_key: stripeSecretKey.trim() || undefined,
        webhook_secret: stripeWebhookSecret.trim() || undefined,
      });
      if (resp?.stripe) setStripe({ ...EMPTY_STRIPE, ...resp.stripe });
      setStripeSecretKey("");
      setStripeWebhookSecret("");
      setStripeMessage({ ok: true, text: t("admin-payment-gateways-save-success", "Settings saved successfully") });
    } catch (err) {
      console.error("Failed to save Stripe settings", err);
      setStripeMessage({
        ok: false,
        text: err instanceof Error && err.message ? err.message.replace(/^HTTP \d+: /, "") : t("admin-payment-gateways-save-failed", "Failed to save settings"),
      });
    } finally {
      setIsSavingStripe(false);
    }
  };

  const sourceLabel = (source: KeySource) =>
    ({
      dashboard: t("admin-payment-gateways-stripe-source-dashboard", "saved on this page"),
      environment: t("admin-payment-gateways-stripe-source-env", "from the server environment (STRIPE_* variables)"),
      legacy: t("admin-payment-gateways-stripe-source-legacy", "saved by the setup API"),
      none: t("admin-payment-gateways-stripe-source-none", "not set"),
    })[source];

  useEffect(() => {
    loadData();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveMessage(null);
    try {
      await putJson(`${apiBase}/v1/admin/settings/payment-gateways`, {
        enabled: config.enabled,
        store_id: config.store_id,
        store_password: storePassword || undefined,
        sandbox: config.sandbox,
      });
      setSaveMessage(t("admin-payment-gateways-save-success") || "Settings saved successfully");
      setStorePassword("");
    } catch (err) {
      console.error("Failed to save payment gateway settings", err);
      setSaveMessage("Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DefaultLayout>
      <div className="max-w-3xl mx-auto py-12">
        <h1 className="text-3xl font-bold mb-6">
          {t("admin-payment-gateways-title") || "Payment Gateways"}
        </h1>

        {/* Stripe Configuration Card */}
        <Card className="mb-6">
          <Card.Header>
            <div className="flex items-start justify-between gap-4 w-full">
              <div>
                <h2 className="text-xl font-semibold">Stripe</h2>
                <p className="text-sm text-default-500">
                  {t("admin-payment-gateways-stripe-desc", "Card payments worldwide through Stripe Checkout")}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                {stripe.mode && (
                  <span
                    className={`text-xs px-2 py-1 rounded-full ${stripe.mode === "live" ? "bg-success-100 text-success-700" : "bg-warning-100 text-warning-700"}`}
                  >
                    {stripe.mode === "live"
                      ? t("admin-payment-gateways-stripe-live", "Live mode")
                      : t("admin-payment-gateways-stripe-test", "Test mode")}
                  </span>
                )}
                <span
                  className={`text-xs px-2 py-1 rounded-full ${stripe.active ? "bg-success-100 text-success-700" : "bg-default-100 text-default-600"}`}
                >
                  {stripe.active
                    ? t("admin-payment-gateways-status-active", "Active at checkout")
                    : t("admin-payment-gateways-status-inactive", "Not offered at checkout")}
                </span>
              </div>
            </div>
          </Card.Header>
          <Card.Content className="space-y-6">
            {/* Enabled toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label>{t("admin-payment-gateways-enabled", "Enabled")}</Label>
                <p className="text-sm text-default-400">
                  {t("admin-payment-gateways-stripe-enabled-desc", "Offer Stripe as a payment option at checkout")}
                </p>
              </div>
              <Switch
                isSelected={stripe.enabled}
                onChange={(v: boolean) => setStripe({ ...stripe, enabled: v })}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>

            {/* Publishable key */}
            <div className="space-y-2">
              <Label>{t("admin-payment-gateways-stripe-publishable-key", "Publishable Key")}</Label>
              <Input
                placeholder="pk_test_..."
                value={stripe.publishable_key}
                onChange={(e) => setStripe({ ...stripe, publishable_key: e.target.value })}
                className="max-w-md"
              />
            </div>

            {/* Secret key */}
            <div className="space-y-2">
              <Label>{t("admin-payment-gateways-stripe-secret-key", "Secret Key")}</Label>
              <Input
                placeholder={
                  stripe.secret_key_set && stripe.secret_key_last4
                    ? `••••••••${stripe.secret_key_last4}`
                    : "sk_test_..."
                }
                type="password"
                autoComplete="off"
                value={stripeSecretKey}
                onChange={(e) => setStripeSecretKey(e.target.value)}
                className="max-w-md"
              />
              <p className="text-sm text-default-400 max-w-md">
                {t("admin-payment-gateways-stripe-current", "Current")}: {sourceLabel(stripe.secret_key_source)}.{" "}
                {t("admin-payment-gateways-password-note", "Leave blank to keep the current value unchanged")}
              </p>
            </div>

            {/* Webhook secret */}
            <div className="space-y-2">
              <Label>{t("admin-payment-gateways-stripe-webhook-secret", "Webhook Signing Secret")}</Label>
              <Input
                placeholder={stripe.webhook_secret_set ? "••••••••" : "whsec_..."}
                type="password"
                autoComplete="off"
                value={stripeWebhookSecret}
                onChange={(e) => setStripeWebhookSecret(e.target.value)}
                className="max-w-md"
              />
              <p className="text-sm text-default-400 max-w-md">
                {t("admin-payment-gateways-stripe-current", "Current")}: {sourceLabel(stripe.webhook_secret_source)}.
              </p>
              {stripe.webhook_url && (
                <p className="text-sm text-default-500 max-w-md break-all">
                  {t("admin-payment-gateways-stripe-webhook-url", "Webhook endpoint to add in the Stripe dashboard")}:{" "}
                  <code className="text-xs">{stripe.webhook_url}</code>
                </p>
              )}
            </div>

            {/* Save button */}
            <div className="flex gap-3 pt-4">
              <Button variant="primary" onPress={handleSaveStripe} isDisabled={isSavingStripe}>
                {isSavingStripe
                  ? t("admin-payment-gateways-saving", "Saving...")
                  : t("admin-payment-gateways-save", "Save Settings")}
              </Button>
              <Button
                variant="secondary"
                onPress={() => {
                  setStripeSecretKey("");
                  setStripeWebhookSecret("");
                  setStripeMessage(null);
                  void loadData();
                }}
                isDisabled={isSavingStripe}
              >
                {t("admin-common-reset", "Reset")}
              </Button>
            </div>

            {stripeMessage && (
              <p className={`text-sm ${stripeMessage.ok ? "text-success" : "text-danger"}`}>{stripeMessage.text}</p>
            )}
          </Card.Content>
        </Card>

        {/* SSLCommerz Configuration Card */}
        <Card className="mb-6">
          <Card.Header>
            <div>
              <h2 className="text-xl font-semibold">SSLCommerz</h2>
              <p className="text-sm text-default-500">
                {t("admin-payment-gateways-sslcommerz-desc") ||
                  "Configure SSLCommerz payment gateway for Bangladesh market"}
              </p>
            </div>
          </Card.Header>
          <Card.Content className="space-y-6">
            {/* Enabled toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label>{t("admin-payment-gateways-enabled") || "Enabled"}</Label>
                <p className="text-sm text-default-400">
                  {t("admin-payment-gateways-enabled-desc") ||
                    "Enable or disable SSLCommerz payment option"}
                </p>
              </div>
              <Switch
                isSelected={config.enabled}
                onChange={(v: boolean) => setConfig({ ...config, enabled: v })}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>

            {/* Sandbox toggle */}
            <div className="flex items-center justify-between">
              <div>
                <Label>{t("admin-payment-gateways-sandbox") || "Sandbox Mode"}</Label>
                <p className="text-sm text-default-400">
                  {t("admin-payment-gateways-sandbox-desc") ||
                    "Use sandbox environment for testing"}
                </p>
              </div>
              <Switch
                isSelected={config.sandbox}
                onChange={(v: boolean) => setConfig({ ...config, sandbox: v })}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
            </div>

            {/* Store ID */}
            <div className="space-y-2">
              <Label>{t("admin-payment-gateways-store-id") || "Store ID"}</Label>
              <Input
                placeholder="your-store-id"
                value={config.store_id}
                onChange={(e) => setConfig({ ...config, store_id: e.target.value })}
                className="max-w-md"
              />
            </div>

            {/* Store Password */}
            <div className="space-y-2">
              <Label>{t("admin-payment-gateways-store-password") || "Store Password"}</Label>
              <Input
                placeholder="Enter new password to update"
                type="password"
                value={storePassword}
                onChange={(e) => setStorePassword(e.target.value)}
                className="max-w-md"
              />
              <Tooltip>
                <Tooltip.Trigger>
                  <p className="text-sm text-default-400 max-w-md cursor-help">
                    {t("admin-payment-gateways-password-note") ||
                      "Leave blank to keep the current password unchanged"}
                  </p>
                </Tooltip.Trigger>
                <Tooltip.Content>
                  Leave blank to keep current password unchanged
                </Tooltip.Content>
              </Tooltip>
            </div>

            {/* Save button */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="primary"
                onPress={handleSave}
                isDisabled={isSaving || !config.store_id}
              >
                {isSaving ? "Saving..." : (t("admin-payment-gateways-save") || "Save Settings")}
              </Button>
              <Button
                variant="secondary"
                onPress={() => loadData()}
                isDisabled={isSaving}
              >
                {t("admin-common-reset") || "Reset"}
              </Button>
            </div>

            {/* Save message */}
            {saveMessage && (
              <p className={`text-sm ${saveMessage.includes("Failed") ? "text-danger" : "text-success"}`}>
                {saveMessage}
              </p>
            )}
          </Card.Content>
        </Card>

        {/* Info Card */}
        <Card className="border-default-200">
          <Card.Header>
            <h3 className="text-lg font-semibold">
              {t("admin-payment-gateways-info") || "Information"}
            </h3>
          </Card.Header>
          <Card.Content className="space-y-2 text-sm text-default-600">
            <p>
              SSLCommerz is a leading payment gateway in Bangladesh supporting
              cards, mobile banking, and internet banking.
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li>Configure your Store ID and Password from the SSLCommerz dashboard</li>
              <li>Use Sandbox mode for testing before going live</li>
              <li>Passwords and Stripe secrets are encrypted using AES-256-CBC before storage</li>
              <li>Stripe keys saved here take precedence over the STRIPE_* environment variables</li>
              <li>The IPN (Instant Payment Notification) endpoint is automatically registered</li>
            </ul>
          </Card.Content>
        </Card>
      </div>
    </DefaultLayout>
  );
}
