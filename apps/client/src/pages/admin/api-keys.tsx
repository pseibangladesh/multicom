/**
 * Admin → API keys (/admin/api-keys): create and revoke keys for scripts,
 * integrations and other storefronts. A new key is shown once; only its hash
 * is stored. The MERCHANT_SK / MERCHANT_PK keys from the server environment
 * are listed but managed in .env.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";

interface ApiKey {
  id: string;
  name: string | null;
  role: "public" | "admin";
  key_prefix: string;
  source: "environment" | "admin";
  created_at: string;
}

const FIELD =
  "w-full rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink focus:outline-none focus:ring-2 focus:ring-bx-primary";
const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";

export default function ApiKeysPage() {
  const { t, i18n } = useTranslation();
  const { getJson, postJson, deleteJson } = useSecuredApi();
  const api = getApiBase();
  const uid = useId();
  const [items, setItems] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"public" | "admin">("public");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    id: string;
    key: string;
    name: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const createdRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = (await getJson(`${api}/v1/admin/api-keys`)) as {
        items: ApiKey[];
      };

      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = (await postJson(`${api}/v1/admin/api-keys`, {
        name: name.trim(),
        role,
      })) as ApiKey & { key: string };

      setCreated({ id: res.id, key: res.key, name: res.name ?? "" });
      setCopied(false);
      setName("");
      await load();
      requestAnimationFrame(() => createdRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (k: ApiKey) => {
    if (
      !window.confirm(
        t("admin-api-keys-revoke-confirm", { name: k.name ?? k.key_prefix }),
      )
    )
      return;
    try {
      await deleteJson(`${api}/v1/admin/api-keys/${k.id}`);
      // Never leave a revoked key on screen.
      if (created?.id === k.id) setCreated(null);
      setNotice(t("admin-api-keys-revoked", { name: k.name ?? k.key_prefix }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const fmtDate = (s: string) => {
    const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");

    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(i18n.language);
  };

  return (
    <div>
      <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
        {t("admin-api-keys-title")}
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-bx-stone">
        {t("admin-api-keys-subtitle")}
      </p>

      <section aria-labelledby={`${uid}-new`} className={`${CARD} mb-6`}>
        <h2
          className="mb-4 text-lg font-semibold text-bx-ink"
          id={`${uid}-new`}
        >
          {t("admin-api-keys-create")}
        </h2>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem_auto] md:items-end">
          <div className="flex flex-col gap-1">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={`${uid}-name`}
            >
              {t("admin-api-keys-name")}
            </label>
            <input
              className={FIELD}
              id={`${uid}-name`}
              maxLength={100}
              placeholder={t("admin-api-keys-name-placeholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={`${uid}-role`}
            >
              {t("admin-api-keys-role")}
            </label>
            <select
              className={FIELD}
              id={`${uid}-role`}
              value={role}
              onChange={(e) => setRole(e.target.value as "public" | "admin")}
            >
              <option value="public">{t("admin-api-keys-role-public")}</option>
              <option value="admin">{t("admin-api-keys-role-admin")}</option>
            </select>
          </div>
          <Button
            isDisabled={!name.trim()}
            isPending={creating}
            variant="primary"
            onPress={create}
          >
            <Plus aria-hidden className="h-4 w-4" />
            {t("admin-api-keys-create-btn")}
          </Button>
        </div>
        <p className="mt-3 text-xs text-bx-stone">
          {role === "admin"
            ? t("admin-api-keys-role-admin-help")
            : t("admin-api-keys-role-public-help")}
        </p>
      </section>

      {created && (
        <div
          ref={createdRef}
          className="mb-6 rounded-md border-2 border-bx-primary bg-bx-surface-raised p-4 md:p-6"
          role="region"
          aria-label={t("admin-api-keys-created-title")}
          tabIndex={-1}
        >
          <h2 className="mb-1 text-lg font-semibold text-bx-ink">
            {t("admin-api-keys-created-title")}
          </h2>
          <p className="mb-3 text-sm text-bx-ink-soft">
            {t("admin-api-keys-created-help")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 break-all rounded border border-bx-line bg-bx-paper px-3 py-2 font-mono text-sm text-bx-ink">
              {created.key}
            </code>
            <Button variant="outline" onPress={copy}>
              <Copy aria-hidden className="h-4 w-4" />
              {copied ? t("admin-api-keys-copied") : t("admin-api-keys-copy")}
            </Button>
          </div>
          <Button
            className="mt-3"
            variant="ghost"
            onPress={() => setCreated(null)}
          >
            {t("admin-api-keys-created-done")}
          </Button>
        </div>
      )}

      <p aria-live="polite" className="mb-4 text-sm text-bx-primary">
        {notice}
      </p>
      {error && (
        <p className="mb-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <section aria-labelledby={`${uid}-list`} className={CARD}>
        <h2
          className="mb-4 text-lg font-semibold text-bx-ink"
          id={`${uid}-list`}
        >
          {t("admin-api-keys-list")}
        </h2>
        {loading ? (
          <p className="text-sm text-bx-stone">{t("loading")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-bx-line">
            {items.map((k) => (
              <li
                key={k.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center"
              >
                <KeyRound
                  aria-hidden
                  className="hidden h-5 w-5 shrink-0 text-bx-stone sm:block"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-bx-ink">
                    {k.name ??
                      (k.source === "environment"
                        ? t("admin-api-keys-env-name")
                        : t("admin-api-keys-unnamed"))}
                  </p>
                  <p className="flex flex-wrap gap-x-3 text-sm text-bx-stone">
                    <span className="font-mono">{k.key_prefix}…</span>
                    <span>
                      {k.role === "admin"
                        ? t("admin-api-keys-role-admin")
                        : t("admin-api-keys-role-public")}
                    </span>
                    <span>{fmtDate(k.created_at)}</span>
                  </p>
                </div>
                {k.source === "environment" ? (
                  <span className="text-sm text-bx-stone">
                    {t("admin-api-keys-env-managed")}
                  </span>
                ) : (
                  <Button
                    aria-label={t("admin-api-keys-revoke-named", {
                      name: k.name ?? k.key_prefix,
                    })}
                    variant="danger"
                    onPress={() => revoke(k)}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                    {t("admin-api-keys-revoke")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
