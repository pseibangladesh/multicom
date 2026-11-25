/**
 * Admin → Pages (/admin/pages): edit the informational pages linked from the
 * footer (About, Blog, FAQ, policies...).
 *
 * Each language is saved separately. A language with no saved edit keeps the
 * built-in text (config/cms-content.ts); "Restore built-in text" removes the
 * edit for one language. Saved with PUT /v1/admin/settings/pages/:handle.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import { ArrowDown, ArrowUp, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Link as RouterLink } from "react-router-dom";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { availableLanguages, languageDirection } from "@/lib/languages";
import { CMS_CONTENT, type CmsPageContent } from "@/config/cms-content";
import { FOOTER_COLUMNS } from "@/config/navigation";
import {
  cmsPageQueryKey,
  fetchCmsPageEdits,
  type CmsPageEdits,
} from "@/lib/site-content";

const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";
const FIELD =
  "w-full rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink";
const LABEL = "text-sm font-medium text-bx-ink";

const HANDLES = Object.keys(CMS_CONTENT);

/** Footer label key for each page ("about" → "footer-about"). */
const PAGE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  FOOTER_COLUMNS.flatMap((c) => c.links)
    .map((l) => [/^\/pages\/(.+)$/.exec(l.href)?.[1], l.key] as const)
    .filter((e): e is readonly [string, string] => Boolean(e[0])),
);

const clone = (p: CmsPageContent): CmsPageContent => ({
  title: p.title,
  lead: p.lead,
  sections: p.sections.map((s) => ({ ...s })),
});

/** What the editor shows for a language with no saved edit. */
function builtInFor(handle: string, locale: string) {
  const page = CMS_CONTENT[handle];
  const exact = page[locale];

  return exact
    ? { content: clone(exact), fallback: false }
    : { content: clone(page["en-US"]), fallback: true };
}

export default function AdminPagesPage() {
  const { t } = useTranslation();
  const { getJson, putJson } = useSecuredApi();
  const api = getApiBase();
  const uid = useId();
  const queryClient = useQueryClient();

  const [handle, setHandle] = useState(HANDLES[0]);
  const [locale, setLocale] = useState("en-US");
  const [edited, setEdited] = useState<Record<string, string[]>>({});
  /** Saved edits from the server, and the working copy. */
  const [saved, setSaved] = useState<CmsPageEdits>({});
  const [draft, setDraft] = useState<CmsPageEdits>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = (await getJson(`${api}/v1/admin/settings/pages`)) as {
          pages: { handle: string; edited_locales: string[] }[];
        };

        setEdited(
          Object.fromEntries(
            res.pages.map((p) => [p.handle, p.edited_locales]),
          ),
        );
      } catch {
        /* only decorates the page list */
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setNotice(null);
    fetchCmsPageEdits(handle)
      .then((edits) => {
        if (cancelled) return;
        setSaved(edits);
        setDraft(edits);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handle]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const hasEdit = Boolean(draft[locale]);
  const savedEdit = Boolean(saved[locale]);
  const base = useMemo(() => builtInFor(handle, locale), [handle, locale]);
  const content = draft[locale] ?? base.content;
  const languageName =
    availableLanguages.find((l) => l.code === locale)?.nativeName ?? locale;
  const titleMissing = Object.values(draft).some((p) => !p.title.trim());

  const change = (fn: (p: CmsPageContent) => CmsPageContent) => {
    setNotice(null);
    setDraft((cur) => ({
      ...cur,
      [locale]: fn(clone(cur[locale] ?? base.content)),
    }));
  };
  const moveSection = (i: number, by: -1 | 1) =>
    change((p) => {
      [p.sections[i], p.sections[i + by]] = [p.sections[i + by], p.sections[i]];

      return p;
    });

  const pickPage = (next: string) => {
    if (dirty && !confirm(t("admin-pages-unsaved"))) return;
    setHandle(next);
  };

  const put = async (edits: CmsPageEdits, message: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = (await putJson(
        `${api}/v1/admin/settings/pages/${encodeURIComponent(handle)}`,
        { content: edits },
      )) as { content: CmsPageEdits };

      setSaved(res.content);
      setDraft(res.content);
      setEdited((cur) => ({ ...cur, [handle]: Object.keys(res.content) }));
      setNotice(message);
      queryClient.setQueryData(cmsPageQueryKey(handle), res.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const restoreLanguage = () => {
    if (!confirm(t("admin-pages-reset-confirm", { language: languageName })))
      return;
    const rest = { ...draft };

    delete rest[locale];

    // Unsaved edits in other languages are saved along with the restore.
    void put(rest, t("admin-pages-restored"));
  };

  const pageLabel = (h: string) =>
    PAGE_LABEL_KEYS[h] ? t(PAGE_LABEL_KEYS[h]) : h;
  const dir = languageDirection(locale);

  return (
    <div>
      <h1 className="font-display text-2xl md:text-3xl text-bx-ink">
        {t("admin-pages-title")}
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-bx-stone">
        {t("admin-pages-subtitle")}
      </p>

      <div className={CARD}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={LABEL} htmlFor={`${uid}-page`}>
              {t("admin-pages-page")}
            </label>
            <select
              className={FIELD}
              id={`${uid}-page`}
              value={handle}
              onChange={(e) => pickPage(e.target.value)}
            >
              {HANDLES.map((h) => (
                <option key={h} value={h}>
                  {pageLabel(h)}
                  {edited[h]?.length ? ` (${t("admin-pages-edited")})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL} htmlFor={`${uid}-lang`}>
              {t("admin-pages-language")}
            </label>
            <select
              className={FIELD}
              id={`${uid}-lang`}
              value={locale}
              onChange={(e) => {
                setNotice(null);
                setLocale(e.target.value);
              }}
            >
              {availableLanguages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName}
                  {draft[l.code] ? ` (${t("admin-pages-edited")})` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <p className="mt-6 text-sm text-bx-stone">{t("loading")}</p>
        ) : (
          <>
            <p className="mt-4 rounded-md bg-bx-paper px-3 py-2 text-sm text-bx-ink-soft">
              {savedEdit
                ? t("admin-pages-source-edited")
                : base.fallback
                  ? t("admin-pages-source-fallback", { language: languageName })
                  : t("admin-pages-source-builtin")}
            </p>

            <div className="mt-6 flex flex-col gap-5" dir={dir} lang={locale}>
              <div className="flex flex-col gap-1">
                <label className={LABEL} htmlFor={`${uid}-title`}>
                  {t("admin-pages-page-title")}
                </label>
                <input
                  aria-describedby={`${uid}-title-help`}
                  aria-invalid={!content.title.trim() || undefined}
                  className={FIELD}
                  id={`${uid}-title`}
                  maxLength={200}
                  value={content.title}
                  onChange={(e) =>
                    change((p) => ({ ...p, title: e.target.value }))
                  }
                />
                {!content.title.trim() && (
                  <p className="text-xs text-danger" id={`${uid}-title-help`}>
                    {t("admin-pages-title-required")}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className={LABEL} htmlFor={`${uid}-lead`}>
                  {t("admin-pages-lead")}
                </label>
                <textarea
                  className={FIELD}
                  id={`${uid}-lead`}
                  maxLength={2000}
                  rows={3}
                  value={content.lead}
                  onChange={(e) =>
                    change((p) => ({ ...p, lead: e.target.value }))
                  }
                />
              </div>

              <fieldset>
                <legend className="mb-2 text-lg font-semibold text-bx-ink">
                  {t("admin-pages-sections")}
                </legend>
                <ol className="flex flex-col gap-4">
                  {content.sections.map((s, i) => {
                    const n = i + 1;
                    const id = `${uid}-s${i}`;

                    return (
                      <li
                        key={i}
                        className="rounded-md border border-bx-line p-3"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-bx-stone">
                            {t("admin-pages-section-n", { n })}
                          </span>
                          <div className="flex gap-1">
                            <Button
                              isIconOnly
                              aria-label={t("admin-pages-move-up", { n })}
                              isDisabled={i === 0}
                              variant="ghost"
                              onPress={() => moveSection(i, -1)}
                            >
                              <ArrowUp aria-hidden className="h-4 w-4" />
                            </Button>
                            <Button
                              isIconOnly
                              aria-label={t("admin-pages-move-down", { n })}
                              isDisabled={i === content.sections.length - 1}
                              variant="ghost"
                              onPress={() => moveSection(i, 1)}
                            >
                              <ArrowDown aria-hidden className="h-4 w-4" />
                            </Button>
                            <Button
                              isIconOnly
                              aria-label={t("admin-pages-remove-section", {
                                n,
                              })}
                              variant="ghost"
                              onPress={() =>
                                change((p) => ({
                                  ...p,
                                  sections: p.sections.filter(
                                    (_, j) => j !== i,
                                  ),
                                }))
                              }
                            >
                              <Trash2 aria-hidden className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-col gap-3">
                          <div className="flex flex-col gap-1">
                            <label className={LABEL} htmlFor={`${id}-h`}>
                              {t("admin-pages-section-heading")}
                            </label>
                            <input
                              className={FIELD}
                              id={`${id}-h`}
                              maxLength={200}
                              value={s.heading}
                              onChange={(e) =>
                                change((p) => {
                                  p.sections[i].heading = e.target.value;

                                  return p;
                                })
                              }
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <label className={LABEL} htmlFor={`${id}-b`}>
                              {t("admin-pages-section-body")}
                            </label>
                            <textarea
                              aria-describedby={`${id}-b-help`}
                              className={FIELD}
                              id={`${id}-b`}
                              rows={5}
                              value={s.body}
                              onChange={(e) =>
                                change((p) => {
                                  p.sections[i].body = e.target.value;

                                  return p;
                                })
                              }
                            />
                            <p
                              className="text-xs text-bx-stone"
                              id={`${id}-b-help`}
                            >
                              {t("admin-pages-body-help")}
                            </p>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <Button
                  className="mt-3"
                  isDisabled={content.sections.length >= 50}
                  variant="secondary"
                  onPress={() =>
                    change((p) => ({
                      ...p,
                      sections: [...p.sections, { heading: "", body: "" }],
                    }))
                  }
                >
                  <Plus aria-hidden className="h-4 w-4" />
                  {t("admin-pages-add-section")}
                </Button>
              </fieldset>
            </div>
          </>
        )}

        {error && (
          <p className="mt-4 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            isDisabled={loading || !dirty || titleMissing}
            isPending={saving}
            variant="primary"
            onPress={() => put(draft, t("admin-pages-saved"))}
          >
            {t("admin-common-save")}
          </Button>
          {(hasEdit || savedEdit) && (
            <Button
              isDisabled={loading || saving}
              variant="tertiary"
              onPress={restoreLanguage}
            >
              {t("admin-pages-reset-language")}
            </Button>
          )}
          <RouterLink
            className="inline-flex items-center gap-1 text-sm text-bx-primary hover:underline"
            rel="noopener noreferrer"
            target="_blank"
            to={`/pages/${handle}`}
          >
            {t("admin-pages-view")}
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </RouterLink>
          <p aria-live="polite" className="text-sm text-bx-primary">
            {notice}
          </p>
        </div>
      </div>
    </div>
  );
}
