/**
 * Admin → Banners (/admin/banners): create, edit, reorder and delete the
 * home-page banners — title, description, image, and up to two buttons with
 * the page each one opens. The first active banner (lowest order) is the one
 * the home page shows; with none active, the built-in banner is shown.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { availableLanguages } from "@/i18n";
import { useCategories } from "@/hooks/use-categories";
import { LocalizedTitleInput } from "@/components/localized-title-input";
import { BannerHero } from "@/components/home-hero";
import {
  type Banner,
  type BannerInput,
  EMPTY_BANNER,
  isSafeLink,
  storedImageKey,
} from "@/lib/banners";
import { uploadImageFile } from "@/utils/image-upload";
import { resolveTitle } from "@/utils/description";

const FIELD =
  "w-full rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink focus:outline-none focus:ring-2 focus:ring-bx-primary";
const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";

/** Pages a banner button can open (plus "custom"). */
function useLinkOptions() {
  const { t, i18n } = useTranslation();
  const { data: categories } = useCategories();

  return useMemo(
    () => [
      { value: "/#catalogue", label: t("admin-banners-link-catalogue") },
      { value: "/products", label: t("admin-banners-link-categories") },
      { value: "/cart", label: t("nav-cart") },
      { value: "/pages/about", label: t("footer-about") },
      { value: "/pages/contact", label: t("footer-contact") },
      { value: "/pages/faq", label: t("footer-faq") },
      { value: "/pages/shipping-policy", label: t("footer-shipping") },
      // Showcase-only categories have no page of their own.
      ...(categories ?? [])
        .filter((c) => c.visibility !== "showcase")
        .map((c) => ({
        value: `/?category=${encodeURIComponent(c.handle)}`,
        label: `${t("categories")}: ${resolveTitle(c.name, i18n.language)}`,
      })),
    ],
    [t, i18n.language, categories],
  );
}

function LinkPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const { t } = useTranslation();
  const options = useLinkOptions();
  const known = value === null || options.some((o) => o.value === value);
  const [custom, setCustom] = useState(!known);

  useEffect(() => {
    if (!known) setCustom(true);
  }, [known]);

  const selectValue = value === null ? "" : custom ? "__custom" : value;
  const invalid = value !== null && value !== "" && !isSafeLink(value);

  return (
    <div className="flex flex-col gap-2">
      <select
        className={FIELD}
        id={id}
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;

          if (v === "__custom") {
            setCustom(true);
            onChange(value && !known ? value : "https://");
          } else {
            setCustom(false);
            onChange(v === "" ? null : v);
          }
        }}
      >
        <option value="">{t("admin-banners-link-none")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="__custom">{t("admin-banners-link-custom")}</option>
      </select>
      {custom && value !== null && (
        <>
          <input
            aria-describedby={invalid ? `${id}-err` : undefined}
            aria-invalid={invalid || undefined}
            aria-label={t("admin-banners-link-custom-url")}
            className={FIELD}
            placeholder="https://… or /pages/…"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {invalid && (
            <p className="text-sm text-danger" id={`${id}-err`}>
              {t("admin-banners-link-invalid")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function BannerEditor({
  initial,
  onDone,
}: {
  initial: Banner | null;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const { postJson, patchJson, deleteJson, postForm } = useSecuredApi();
  const api = getApiBase();
  const uid = useId();
  const [form, setForm] = useState<BannerInput>(initial ?? EMPTY_BANNER);
  const [locale, setLocale] = useState(
    availableLanguages.find((l) => l.isDefault)?.code ?? "en-US",
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imageUrlDraft, setImageUrlDraft] = useState("");
  // Images uploaded in this editor session that aren't saved yet.
  const uploaded = useRef<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const set = <K extends keyof BannerInput>(k: K, v: BannerInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const id = (name: string) => `${uid}-${name}`;

  const deleteStored = async (url: string | null) => {
    const key = storedImageKey(url);

    if (key) await deleteJson(`${api}/v1/images/${key}`).catch(() => undefined);
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const res = await uploadImageFile(file, api, postForm, true);

      uploaded.current.add(res.url);
      set("image_url", res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const ctaProblem = (["primary", "secondary"] as const).find((w) => {
    const label = form[`cta_${w}_label`];
    const href = form[`cta_${w}_href`];

    return (
      Boolean(label) !== Boolean(href) || (href ? !isSafeLink(href) : false)
    );
  });
  const canSave =
    Boolean(form.title.trim()) && !ctaProblem && !saving && !uploading;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        ...form,
        cta_primary_label: form.cta_primary_label || null,
        cta_primary_href: form.cta_primary_href || null,
        cta_secondary_label: form.cta_secondary_label || null,
        cta_secondary_href: form.cta_secondary_href || null,
      };

      if (initial)
        await patchJson(`${api}/v1/admin/banners/${initial.id}`, body);
      else await postJson(`${api}/v1/admin/banners`, body);
      // Drop images this banner no longer uses.
      const orphans = [...uploaded.current, initial?.image_url ?? null].filter(
        (u): u is string => Boolean(u) && u !== form.image_url,
      );

      await Promise.all(orphans.map(deleteStored));
      onDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    await Promise.all([...uploaded.current].map(deleteStored));
    onDone(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className={CARD}>
        <h2 className="mb-4 font-display text-2xl text-bx-ink">
          {initial ? t("admin-banners-edit") : t("admin-banners-create")}
        </h2>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex flex-col gap-1 md:col-span-2">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={id("locale")}
            >
              {t("admin-products-title-locale")}
            </label>
            <select
              className={`${FIELD} md:w-64`}
              id={id("locale")}
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {availableLanguages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName}
                </option>
              ))}
            </select>
            <p className="text-xs text-bx-stone">
              {t("admin-banners-locale-help")}
            </p>
          </div>

          <div className="flex flex-col gap-1 md:col-span-2">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={id("title")}
            >
              {t("admin-banners-field-title")} *
            </label>
            <LocalizedTitleInput
              required
              id={id("title")}
              locale={locale}
              placeholder={t("home-hero-title")}
              value={form.title}
              onChange={(v) => set("title", v)}
            />
          </div>

          <div className="flex flex-col gap-1 md:col-span-2">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={id("desc")}
            >
              {t("admin-banners-field-description")}
            </label>
            <LocalizedTitleInput
              id={id("desc")}
              locale={locale}
              placeholder={t("home-hero-text")}
              value={form.description}
              onChange={(v) => set("description", v)}
            />
          </div>

          {/* Image */}
          <fieldset className="flex flex-col gap-3 md:col-span-2">
            <legend className="mb-1 text-sm font-medium text-bx-ink">
              {t("admin-banners-field-image")}
            </legend>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-bx-line bg-bx-paper sm:w-48">
                {form.image_url ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    src={form.image_url}
                  />
                ) : (
                  <span className="px-2 text-center text-xs text-bx-stone">
                    {t("admin-banners-no-image")}
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={fileInput}
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="sr-only"
                    id={id("file")}
                    type="file"
                    onChange={(e) => onUpload(e.target.files?.[0])}
                  />
                  <Button
                    isPending={uploading}
                    variant="outline"
                    onPress={() => fileInput.current?.click()}
                  >
                    <ImagePlus aria-hidden className="h-4 w-4" />
                    {form.image_url
                      ? t("admin-banners-image-replace")
                      : t("admin-banners-image-upload")}
                  </Button>
                  {form.image_url && (
                    <Button
                      variant="ghost"
                      onPress={() => set("image_url", null)}
                    >
                      <Trash2 aria-hidden className="h-4 w-4" />
                      {t("admin-banners-image-remove")}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-bx-stone">
                  {t("admin-banners-image-help")}
                </p>
                <div className="flex gap-2">
                  <input
                    aria-label={t("admin-banners-image-url")}
                    className={FIELD}
                    placeholder="https://…"
                    type="url"
                    value={imageUrlDraft}
                    onChange={(e) => setImageUrlDraft(e.target.value)}
                  />
                  <Button
                    isDisabled={!/^https?:\/\/\S+$/.test(imageUrlDraft)}
                    variant="outline"
                    onPress={() => {
                      set("image_url", imageUrlDraft);
                      setImageUrlDraft("");
                    }}
                  >
                    {t("admin-banners-image-use-url")}
                  </Button>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-bx-ink" htmlFor={id("alt")}>
                    {t("admin-banners-field-alt")}
                  </label>
                  <LocalizedTitleInput
                    id={id("alt")}
                    locale={locale}
                    placeholder={t("admin-banners-alt-placeholder")}
                    value={form.image_alt}
                    onChange={(v) => set("image_alt", v)}
                  />
                </div>
              </div>
            </div>
          </fieldset>

          {/* Buttons */}
          {(["primary", "secondary"] as const).map((which) => (
            <fieldset
              key={which}
              className="flex flex-col gap-3 rounded-md border border-bx-line p-4"
            >
              <legend className="px-1 text-sm font-medium text-bx-ink">
                {which === "primary"
                  ? t("admin-banners-cta-primary")
                  : t("admin-banners-cta-secondary")}
              </legend>
              <div className="flex flex-col gap-1">
                <label
                  className="text-sm text-bx-ink"
                  htmlFor={id(`${which}-label`)}
                >
                  {t("admin-banners-cta-label")}
                </label>
                <LocalizedTitleInput
                  id={id(`${which}-label`)}
                  locale={locale}
                  placeholder={
                    which === "primary"
                      ? t("home-hero-shop-all")
                      : t("home-hero-browse-categories")
                  }
                  value={form[`cta_${which}_label`] ?? ""}
                  onChange={(v) => set(`cta_${which}_label`, v || null)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label
                  className="text-sm text-bx-ink"
                  htmlFor={id(`${which}-href`)}
                >
                  {t("admin-banners-cta-link")}
                </label>
                <LinkPicker
                  id={id(`${which}-href`)}
                  value={form[`cta_${which}_href`]}
                  onChange={(v) => set(`cta_${which}_href`, v)}
                />
              </div>
              {ctaProblem === which && (
                <p className="text-sm text-danger">
                  {t("admin-banners-cta-incomplete")}
                </p>
              )}
            </fieldset>
          ))}

          <div className="flex flex-col gap-1">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={id("status")}
            >
              {t("admin-common-status")}
            </label>
            <select
              className={FIELD}
              id={id("status")}
              value={form.status}
              onChange={(e) =>
                set("status", e.target.value as BannerInput["status"])
              }
            >
              <option value="active">{t("admin-banners-status-active")}</option>
              <option value="draft">{t("admin-banners-status-draft")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={id("order")}
            >
              {t("admin-banners-field-order")}
            </label>
            <input
              className={FIELD}
              id={id("order")}
              min={0}
              type="number"
              value={form.sort_order}
              onChange={(e) =>
                set("sort_order", Math.max(0, Number(e.target.value) || 0))
              }
            />
          </div>
        </div>

        {error && (
          <p
            ref={errorRef}
            className="mt-4 text-sm text-danger"
            role="alert"
            tabIndex={-1}
          >
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="tertiary" onPress={cancel}>
            {t("admin-common-cancel")}
          </Button>
          <Button
            isDisabled={!canSave}
            isPending={saving}
            variant="primary"
            onPress={save}
          >
            {t("admin-common-save")}
          </Button>
        </div>
      </div>

      <section aria-labelledby={id("preview")} className={CARD}>
        <h2
          className="mb-2 text-sm font-semibold uppercase tracking-wide text-bx-stone"
          id={id("preview")}
        >
          {t("admin-banners-preview")}
        </h2>
        {form.title.trim() ? (
          <BannerHero banner={form} headingLevel={2} />
        ) : (
          <p className="text-sm text-bx-stone">
            {t("admin-banners-preview-empty")}
          </p>
        )}
      </section>
    </div>
  );
}

export default function BannersPage() {
  const { t, i18n } = useTranslation();
  const { getJson, patchJson, deleteJson } = useSecuredApi();
  const api = getApiBase();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<Banner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Banner | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = (await getJson(`${api}/v1/admin/banners`)) as {
        items: Banner[];
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

  const refreshStorefront = () =>
    queryClient.invalidateQueries({ queryKey: ["banners"] });

  const move = async (index: number, delta: -1 | 1) => {
    const other = index + delta;

    if (other < 0 || other >= items.length) return;
    // Renumber everything so equal orders can't tie.
    const reordered = [...items];

    [reordered[index], reordered[other]] = [reordered[other], reordered[index]];
    try {
      await Promise.all(
        reordered.map((b, i) =>
          b.sort_order === i * 10
            ? null
            : patchJson(`${api}/v1/admin/banners/${b.id}`, {
                sort_order: i * 10,
              }),
        ),
      );
      await load();
      refreshStorefront();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (b: Banner) => {
    if (
      !window.confirm(
        t("admin-banners-delete-confirm", {
          title: resolveTitle(b.title, i18n.language),
        }),
      )
    )
      return;
    try {
      await deleteJson(`${api}/v1/admin/banners/${b.id}`);
      const key = storedImageKey(b.image_url);

      if (key)
        await deleteJson(`${api}/v1/images/${key}`).catch(() => undefined);
      setNotice(t("admin-banners-deleted"));
      await load();
      refreshStorefront();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const firstActive = items.find((b) => b.status === "active");

  if (editing) {
    return (
      <div>
        <h1 className="mb-6 font-display text-3xl text-bx-ink">
          {t("admin-banners-title")}
        </h1>
        <BannerEditor
          initial={editing === "new" ? null : editing}
          onDone={async (saved) => {
            setEditing(null);
            if (saved) {
              setNotice(t("admin-banners-saved"));
              await load();
              refreshStorefront();
            }
          }}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-bx-ink">
            {t("admin-banners-title")}
          </h1>
          <p className="mt-1 text-sm text-bx-stone">
            {t("admin-banners-subtitle")}
          </p>
        </div>
        <Button
          variant="primary"
          onPress={() => {
            setNotice(null);
            setEditing("new");
          }}
        >
          <Plus aria-hidden className="h-4 w-4" />
          {t("admin-banners-create")}
        </Button>
      </div>

      <p aria-live="polite" className="mb-4 text-sm text-bx-primary">
        {notice}
      </p>
      {error && (
        <p className="mb-4 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-bx-stone">{t("loading")}</p>}
      {!loading && items.length === 0 && (
        <div className={CARD}>
          <p className="text-bx-ink">{t("admin-banners-empty")}</p>
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {items.map((b, i) => {
          const title = resolveTitle(b.title, i18n.language);

          return (
            <li
              key={b.id}
              className={`${CARD} flex flex-col gap-4 sm:flex-row sm:items-center`}
            >
              <div className="flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded border border-bx-line bg-bx-paper sm:w-32">
                {b.image_url ? (
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    src={b.image_url}
                  />
                ) : (
                  <span className="text-xs text-bx-stone">
                    {t("admin-banners-no-image")}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-xl text-bx-ink">
                  {title}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-bx-stone">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      b.status === "active"
                        ? "bg-bx-indigo-tint text-bx-primary"
                        : "bg-bx-paper text-bx-ink-soft"
                    }`}
                  >
                    {b.status === "active"
                      ? t("admin-banners-status-active")
                      : t("admin-banners-status-draft")}
                  </span>
                  {firstActive?.id === b.id && (
                    <span>{t("admin-banners-live")}</span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  isIconOnly
                  aria-label={t("admin-banners-move-up", { title })}
                  isDisabled={i === 0}
                  variant="ghost"
                  onPress={() => move(i, -1)}
                >
                  <ArrowUp aria-hidden className="h-4 w-4" />
                </Button>
                <Button
                  isIconOnly
                  aria-label={t("admin-banners-move-down", { title })}
                  isDisabled={i === items.length - 1}
                  variant="ghost"
                  onPress={() => move(i, 1)}
                >
                  <ArrowDown aria-hidden className="h-4 w-4" />
                </Button>
                <Button
                  aria-label={t("admin-banners-edit-named", { title })}
                  variant="outline"
                  onPress={() => {
                    setNotice(null);
                    setEditing(b);
                  }}
                >
                  <Pencil aria-hidden className="h-4 w-4" />
                  {t("admin-common-edit")}
                </Button>
                <Button
                  aria-label={t("admin-banners-delete-named", { title })}
                  variant="danger"
                  onPress={() => remove(b)}
                >
                  <Trash2 aria-hidden className="h-4 w-4" />
                  {t("admin-common-delete")}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
