/**
 * Admin → AI agents & UCP (/admin/ai-agents):
 *   - UCP (Universal Commerce Protocol): let AI shopping agents browse and buy,
 *     on/off switch and the discovery URL to give them.
 *   - AI features (translation, review moderation): which provider config is
 *     active and its models. Keys are never sent to the browser. The encrypted
 *     config itself is managed with `npm run ai:kv:push` (see CLAUDE.md).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Switch } from "@heroui/react";
import { Copy, ExternalLink } from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";

interface Status {
  ucp: { enabled: boolean; discovery_url: string };
  ai: {
    source: "kv" | "environment" | "none";
    gateway: boolean;
    providers: {
      key: string;
      protocol: string;
      models: { id: string; usage: string; priority: number }[];
      active_keys: number;
      expired_keys: number;
    }[];
  };
}

const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";

export default function AiAgentsPage() {
  const { t } = useTranslation();
  const { getJson, putJson } = useSecuredApi();
  const api = getApiBase();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setStatus(
          (await getJson(`${api}/v1/admin/settings/ai-agents`)) as Status,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const setUcp = async (enabled: boolean) => {
    if (!status) return;
    setSaving(true);
    setError(null);
    try {
      await putJson(`${api}/v1/admin/settings/ucp`, { enabled });
      setStatus({ ...status, ucp: { ...status.ucp, enabled } });
      setNotice(enabled ? t("admin-ai-ucp-now-on") : t("admin-ai-ucp-now-off"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const sourceLabel = {
    kv: t("admin-ai-source-kv"),
    environment: t("admin-ai-source-env"),
    none: t("admin-ai-source-none"),
  };

  return (
    <div>
      <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
        {t("admin-ai-agents-title")}
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-bx-stone">
        {t("admin-ai-subtitle")}
      </p>

      {error && (
        <p className="mb-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!status && !error && (
        <p className="text-sm text-bx-stone">{t("loading")}</p>
      )}

      {status && (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="ucp-title" className={CARD}>
            <h2 className="text-lg font-semibold text-bx-ink" id="ucp-title">
              {t("admin-ai-ucp-title")}
            </h2>
            <p className="mt-1 mb-4 max-w-2xl text-sm text-bx-ink-soft">
              {t("admin-ai-ucp-desc")}
            </p>

            <Switch
              isDisabled={saving}
              isSelected={status.ucp.enabled}
              onChange={setUcp}
            >
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Switch.Content>{t("admin-ai-ucp-switch")}</Switch.Content>
            </Switch>
            <p aria-live="polite" className="mt-2 text-sm text-bx-primary">
              {notice}
            </p>

            <div className="mt-4">
              <p className="mb-1 text-sm font-medium text-bx-ink">
                {t("admin-ai-ucp-discovery")}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 break-all rounded border border-bx-line bg-bx-paper px-3 py-2 font-mono text-sm text-bx-ink">
                  {status.ucp.discovery_url}
                </code>
                <Button
                  variant="outline"
                  onPress={() => copy(status.ucp.discovery_url)}
                >
                  <Copy aria-hidden className="h-4 w-4" />
                  {copied
                    ? t("admin-api-keys-copied")
                    : t("admin-api-keys-copy")}
                </Button>
                {status.ucp.enabled && (
                  <a
                    className="inline-flex items-center gap-1 text-sm text-bx-primary hover:underline"
                    href={status.ucp.discovery_url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {t("admin-ai-open")}
                    <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                    <span className="sr-only">{t("admin-opens-new-tab")}</span>
                  </a>
                )}
              </div>
            </div>
          </section>

          <section aria-labelledby="ai-title" className={CARD}>
            <h2 className="text-lg font-semibold text-bx-ink" id="ai-title">
              {t("admin-ai-features-title")}
            </h2>
            <p className="mt-1 mb-4 max-w-2xl text-sm text-bx-ink-soft">
              {t("admin-ai-features-desc")}
            </p>

            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
              <dt className="text-bx-stone">{t("admin-ai-source")}</dt>
              <dd className="font-medium text-bx-ink">
                {sourceLabel[status.ai.source]}
              </dd>
              <dt className="text-bx-stone">{t("admin-ai-gateway")}</dt>
              <dd className="text-bx-ink">
                {status.ai.gateway
                  ? t("admin-dashboard-enabled")
                  : t("admin-dashboard-disabled")}
              </dd>
            </dl>

            {status.ai.providers.length > 0 && (
              <ul className="mt-4 flex flex-col gap-3">
                {status.ai.providers.map((p) => (
                  <li
                    key={p.key}
                    className="rounded-md border border-bx-line p-3"
                  >
                    <p className="font-medium text-bx-ink">
                      {p.key}{" "}
                      <span className="text-sm font-normal text-bx-stone">
                        ({p.protocol})
                      </span>
                    </p>
                    <p className="text-sm text-bx-ink-soft">
                      {t("admin-ai-keys-count", {
                        active: p.active_keys,
                        expired: p.expired_keys,
                      })}
                    </p>
                    <p className="mt-1 text-sm text-bx-ink-soft">
                      {t("admin-ai-models")}:{" "}
                      {p.models.map((m) => `${m.id} (${m.usage})`).join(", ")}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 rounded-md bg-bx-paper p-3 text-sm text-bx-ink-soft">
              <p>{t("admin-ai-config-help")}</p>
              <code className="mt-2 block font-mono text-xs text-bx-ink">
                npm run ai:encrypt &amp;&amp; npm run ai:kv:push
              </code>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
