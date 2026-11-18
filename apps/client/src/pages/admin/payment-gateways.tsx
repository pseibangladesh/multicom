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

  const loadData = async () => {
    try {
      const resp = await getJson(`${apiBase}/v1/admin/settings/payment-gateways`);
      if (resp?.sslcommerz) {
        setConfig(resp.sslcommerz);
      }
    } catch (err) {
      console.error("Failed to load payment gateway settings", err);
    }
  };

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
              <li>Passwords are encrypted using AES-256-CBC before storage</li>
              <li>The IPN (Instant Payment Notification) endpoint is automatically registered</li>
            </ul>
          </Card.Content>
        </Card>
      </div>
    </DefaultLayout>
  );
}
