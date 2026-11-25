/**
 * Admin → Social links (/admin/social-links): the icons in the storefront
 * footer, in order. Saved with PUT /v1/admin/settings/social-links.
 */
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import {
  SOCIAL_PLATFORMS,
  fetchSocialLinks,
  isSafeExternalUrl,
  socialLinksQueryKey,
  type SocialLink,
} from "@/lib/site-content";
import { SOCIAL_PLATFORM_LABELS, SocialIcon } from "@/shared/ui/social-icons";

/** Matches MAX_SOCIAL_LINKS on the backend. */
const MAX_LINKS = 20;

const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";
const FIELD =
  "w-full rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink";

/** Rows get a stable id so React keeps focus when they move. */
type Row = SocialLink & { id: number };

let nextId = 1;
const toRows = (links: SocialLink[]): Row[] =>
  links.map((l) => ({ ...l, id: nextId++ }));
const toLinks = (rows: Row[]): SocialLink[] =>
  rows.map(({ platform, url }) => ({ platform, url: url.trim() }));

const labelOf = (platform: string) =>
  SOCIAL_PLATFORM_LABELS[platform] ?? platform;

export default function SocialLinksPage() {
  const { t } = useTranslation();
  const { putJson } = useSecuredApi();
  const api = getApiBase();
  const uid = useId();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const links = await fetchSocialLinks();

        setRows(toRows(links));
        setSaved(JSON.stringify(links));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const edit = (fn: (cur: Row[]) => Row[]) => {
    setNotice(null);
    setRows(fn);
  };
  const update = (id: number, patch: Partial<SocialLink>) =>
    edit((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i: number, by: -1 | 1) =>
    edit((cur) => {
      const next = [...cur];

      [next[i], next[i + by]] = [next[i + by], next[i]];

      return next;
    });

  const invalid = rows.some((r) => !isSafeExternalUrl(r.url));
  const dirty = saved !== null && JSON.stringify(toLinks(rows)) !== saved;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = (await putJson(`${api}/v1/admin/settings/social-links`, {
        links: toLinks(rows),
      })) as { links: SocialLink[] };

      setRows(toRows(res.links));
      setSaved(JSON.stringify(res.links));
      setNotice(t("admin-social-saved"));
      queryClient.setQueryData(socialLinksQueryKey, res.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
        {t("admin-social-title")}
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-bx-stone">
        {t("admin-social-subtitle")}
      </p>

      {loading ? (
        <p className="text-sm text-bx-stone">{t("loading")}</p>
      ) : (
        <div className={CARD}>
          {rows.length === 0 ? (
            <p className="text-sm text-bx-stone">{t("admin-social-empty")}</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {rows.map((r, i) => {
                const name = labelOf(r.platform);
                const urlId = `${uid}-url-${r.id}`;
                const showInvalid =
                  r.url.trim() !== "" && !isSafeExternalUrl(r.url);
                const missing = r.url.trim() === "";

                return (
                  <li
                    key={r.id}
                    className="grid gap-3 border-b border-bx-line pb-4 last:border-b-0 last:pb-0 sm:grid-cols-[12rem_1fr_auto] sm:items-start"
                  >
                    <div className="flex flex-col gap-1">
                      <label
                        className="text-sm font-medium text-bx-ink"
                        htmlFor={`${uid}-platform-${r.id}`}
                      >
                        {t("admin-social-platform")}
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-bx-ink-soft">
                          <SocialIcon platform={r.platform} size={18} />
                        </span>
                        <select
                          className={FIELD}
                          id={`${uid}-platform-${r.id}`}
                          value={r.platform}
                          onChange={(e) =>
                            update(r.id, { platform: e.target.value })
                          }
                        >
                          {SOCIAL_PLATFORMS.map((p) => (
                            <option key={p} value={p}>
                              {labelOf(p)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label
                        className="text-sm font-medium text-bx-ink"
                        htmlFor={urlId}
                      >
                        {t("admin-social-url")}
                      </label>
                      <input
                        aria-describedby={`${urlId}-help`}
                        aria-invalid={showInvalid || missing || undefined}
                        className={FIELD}
                        dir="ltr"
                        id={urlId}
                        inputMode="url"
                        placeholder="https://"
                        type="url"
                        value={r.url}
                        onChange={(e) => update(r.id, { url: e.target.value })}
                      />
                      <p
                        className={`text-xs ${showInvalid ? "text-danger" : "text-bx-stone"}`}
                        id={`${urlId}-help`}
                      >
                        {showInvalid
                          ? t("admin-social-url-invalid")
                          : t("admin-social-url-help")}
                      </p>
                    </div>

                    <div className="flex gap-1 sm:pt-6">
                      <Button
                        isIconOnly
                        aria-label={t("admin-social-move-up", { name })}
                        isDisabled={i === 0}
                        variant="ghost"
                        onPress={() => move(i, -1)}
                      >
                        <ArrowUp aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        isIconOnly
                        aria-label={t("admin-social-move-down", { name })}
                        isDisabled={i === rows.length - 1}
                        variant="ghost"
                        onPress={() => move(i, 1)}
                      >
                        <ArrowDown aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        isIconOnly
                        aria-label={t("admin-social-remove", { name })}
                        variant="ghost"
                        onPress={() =>
                          edit((cur) => cur.filter((x) => x.id !== r.id))
                        }
                      >
                        <Trash2 aria-hidden className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <div className="mt-4">
            <Button
              isDisabled={rows.length >= MAX_LINKS}
              variant="secondary"
              onPress={() =>
                edit((cur) => [
                  ...cur,
                  { id: nextId++, platform: "facebook", url: "" },
                ])
              }
            >
              <Plus aria-hidden className="h-4 w-4" />
              {t("admin-social-add")}
            </Button>
            {rows.length >= MAX_LINKS && (
              <p className="mt-1 text-xs text-bx-stone">
                {t("admin-social-limit", { max: MAX_LINKS })}
              </p>
            )}
          </div>

          {error && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex items-center gap-4">
            <Button
              isDisabled={!dirty || invalid}
              isPending={saving}
              variant="primary"
              onPress={save}
            >
              {t("admin-common-save")}
            </Button>
            <p aria-live="polite" className="text-sm text-bx-primary">
              {notice}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
