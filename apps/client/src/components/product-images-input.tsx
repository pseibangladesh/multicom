/**
 * Product photo gallery editor (Admin → Products → create / edit).
 *
 * Several images per product, in order; the first is the cover shown on cards
 * and as the main photo. Files are converted to WebP and stored in R2; links
 * to images hosted elsewhere can be added too. Each image has a description
 * for screen readers, per language like the product title.
 *
 * Uploads are reported through onUploaded so the page can delete files that
 * end up unused (removed before saving, or the form was cancelled).
 */
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Link2,
  Star,
  Trash2,
} from "lucide-react";

import { LocalizedTitleInput } from "@/components/localized-title-input";
import { useSecuredApi } from "@/authentication";
import { uploadImageFile } from "@/utils/image-upload";
import { convertToWebp } from "@/utils/image-utils";

export interface ProductImage {
  url: string;
  alt: string;
}

/** Must match MAX_PRODUCT_IMAGES in the backend (lib/product-images.ts). */
export const MAX_PRODUCT_IMAGES = 20;

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

interface Props {
  value: ProductImage[];
  onChange: (images: ProductImage[]) => void;
  /** Locale whose image descriptions are being edited. */
  locale: string;
  apiBaseUrl: string;
  /** Called with the URL of every file uploaded to our storage. */
  onUploaded?: (url: string) => void;
  /** Lets the parent block saving while files are uploading. */
  onBusyChange?: (busy: boolean) => void;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);

    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function ProductImagesInput({
  value,
  onChange,
  locale,
  apiBaseUrl,
  onUploaded,
  onBusyChange,
}: Props) {
  const { t } = useTranslation();
  const { postForm } = useSecuredApi();
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  // Uploads finish one by one; keep the latest list so none is lost.
  const latest = useRef(value);

  latest.current = value;

  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [errors, setErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const room = MAX_PRODUCT_IMAGES - value.length;
  const uploading = progress !== undefined;

  const update = (next: ProductImage[]) => {
    latest.current = next;
    onChange(next);
  };

  const addFiles = async (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => ACCEPT.includes(f.type));
    const skipped = Array.from(list).length - files.length;
    const take = files.slice(0, Math.max(0, room));
    const errs: string[] = [];

    if (skipped > 0) errs.push(t("admin-products-images-wrong-type"));
    if (files.length > take.length)
      errs.push(
        t("admin-products-images-too-many", { max: MAX_PRODUCT_IMAGES }),
      );
    if (take.length === 0) {
      setErrors(errs);

      return;
    }

    setErrors([]);
    setProgress({ done: 0, total: take.length });
    onBusyChange?.(true);
    let added = 0;

    for (const [i, file] of take.entries()) {
      try {
        const webp = await convertToWebp(file, 1600, 0.85);
        const webpFile = new File(
          [webp],
          file.name.replace(/\.[^.]+$/, "") + ".webp",
          { type: "image/webp" },
        );
        const res = await uploadImageFile(webpFile, apiBaseUrl, postForm, true);

        onUploaded?.(res.url);
        if (!latest.current.some((img) => img.url === res.url)) {
          update([...latest.current, { url: res.url, alt: "" }]);
          added++;
        }
      } catch (e) {
        errs.push(
          `${file.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      setProgress({ done: i + 1, total: take.length });
    }

    setProgress(undefined);
    onBusyChange?.(false);
    setErrors(errs);
    setStatus(t("admin-products-images-added", { n: added }));
    if (fileInput.current) fileInput.current.value = "";
  };

  const addUrl = () => {
    const url = urlInput.trim();

    if (!isHttpUrl(url)) {
      setUrlError(t("admin-products-images-url-invalid"));

      return;
    }
    if (value.some((img) => img.url === url)) {
      setUrlError(t("admin-products-images-duplicate"));

      return;
    }
    if (room <= 0) {
      setUrlError(
        t("admin-products-images-too-many", { max: MAX_PRODUCT_IMAGES }),
      );

      return;
    }
    update([...value, { url, alt: "" }]);
    setUrlInput("");
    setUrlError(null);
    setStatus(t("admin-products-images-added", { n: 1 }));
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    const [img] = next.splice(from, 1);

    next.splice(to, 0, img);
    update(next);
    setStatus(
      to === 0
        ? t("admin-products-images-now-cover", { n: from + 1 })
        : t("admin-products-images-moved", { from: from + 1, to: to + 1 }),
    );
  };

  const remove = (i: number) => {
    update(value.filter((_, j) => j !== i));
    setStatus(t("admin-products-images-removed", { n: i + 1 }));
  };

  const setAlt = (i: number, alt: string) =>
    update(value.map((img, j) => (j === i ? { ...img, alt } : img)));

  return (
    <fieldset className="rounded-md border border-bx-line p-4">
      <legend className="px-1 text-sm font-medium text-bx-ink">
        {t("admin-products-images-title")}
      </legend>
      <p className="mb-3 text-xs text-bx-stone" id={`${uid}-help`}>
        {t("admin-products-images-help", { max: MAX_PRODUCT_IMAGES })}
      </p>

      {value.length > 0 && (
        <ol className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {value.map((img, i) => (
            <li
              key={img.url}
              className="flex flex-col overflow-hidden rounded-md border border-bx-line bg-bx-surface"
            >
              <div className="relative aspect-square bg-bx-paper">
                <img
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                  src={img.url}
                />
                <span className="absolute left-2 top-2 rounded bg-bx-surface/90 px-2 py-0.5 text-xs font-medium text-bx-ink">
                  {i === 0
                    ? t("admin-products-images-cover")
                    : t("admin-products-images-position", {
                        n: i + 1,
                        total: value.length,
                      })}
                </span>
              </div>
              <div className="flex flex-col gap-2 p-2">
                <label
                  className="text-xs font-medium text-bx-ink"
                  htmlFor={`${uid}-alt-${i}`}
                >
                  {t("admin-products-images-alt")}
                </label>
                <LocalizedTitleInput
                  id={`${uid}-alt-${i}`}
                  locale={locale}
                  placeholder={t("admin-banners-alt-placeholder")}
                  value={img.alt}
                  onChange={(v) => setAlt(i, v)}
                />
                <div className="flex flex-wrap gap-1">
                  <Button
                    isIconOnly
                    aria-label={t("admin-products-images-move-earlier", {
                      n: i + 1,
                    })}
                    isDisabled={i === 0}
                    size="sm"
                    variant="ghost"
                    onPress={() => move(i, i - 1)}
                  >
                    <ArrowLeft aria-hidden className="h-4 w-4 rtl:rotate-180" />
                  </Button>
                  <Button
                    isIconOnly
                    aria-label={t("admin-products-images-move-later", {
                      n: i + 1,
                    })}
                    isDisabled={i === value.length - 1}
                    size="sm"
                    variant="ghost"
                    onPress={() => move(i, i + 1)}
                  >
                    <ArrowRight
                      aria-hidden
                      className="h-4 w-4 rtl:rotate-180"
                    />
                  </Button>
                  {i > 0 && (
                    <Button
                      aria-label={t("admin-products-images-make-cover-n", {
                        n: i + 1,
                      })}
                      size="sm"
                      variant="ghost"
                      onPress={() => move(i, 0)}
                    >
                      <Star aria-hidden className="h-4 w-4" />
                      {t("admin-products-images-make-cover")}
                    </Button>
                  )}
                  <Button
                    aria-label={t("admin-products-images-remove-n", {
                      n: i + 1,
                    })}
                    className="ms-auto"
                    size="sm"
                    variant="danger-soft"
                    onPress={() => remove(i)}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                    {t("admin-common-delete")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {room > 0 ? (
        <div
          className={`flex flex-col items-center gap-2 rounded-md border-2 border-dashed p-6 text-center ${
            dragOver
              ? "border-bx-primary bg-bx-indigo-tint"
              : "border-bx-field-line"
          }`}
          onDragLeave={() => setDragOver(false)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (!uploading) void addFiles(e.dataTransfer.files);
          }}
        >
          <ImagePlus aria-hidden className="h-6 w-6 text-bx-stone" />
          <p className="text-sm text-bx-ink-soft">
            {t("admin-products-images-drop")}
          </p>
          <input
            ref={fileInput}
            multiple
            accept={ACCEPT}
            aria-describedby={`${uid}-help`}
            aria-label={t("admin-products-images-choose")}
            className="sr-only"
            id={`${uid}-file`}
            tabIndex={-1}
            type="file"
            onChange={(e) => e.target.files && void addFiles(e.target.files)}
          />
          <Button
            isPending={uploading}
            variant="outline"
            onPress={() => fileInput.current?.click()}
          >
            <ImagePlus aria-hidden className="h-4 w-4" />
            {t("admin-products-images-choose")}
          </Button>
          <p className="text-xs text-bx-stone">
            {t("admin-products-images-count", {
              n: value.length,
              max: MAX_PRODUCT_IMAGES,
            })}
          </p>
        </div>
      ) : (
        <p className="text-sm text-bx-stone">
          {t("admin-products-images-full", { max: MAX_PRODUCT_IMAGES })}
        </p>
      )}

      {room > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <label
            className="text-xs font-medium text-bx-ink"
            htmlFor={`${uid}-url`}
          >
            {t("admin-products-images-url")}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              aria-describedby={urlError ? `${uid}-url-error` : undefined}
              aria-invalid={urlError ? true : undefined}
              className="min-w-0 flex-1 rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink focus:outline-none focus:ring-2 focus:ring-bx-primary"
              id={`${uid}-url`}
              inputMode="url"
              placeholder="https://"
              value={urlInput}
              onChange={(e) => {
                setUrlInput(e.target.value);
                setUrlError(null);
              }}
              onKeyDown={(e) => {
                // Don't submit the product form.
                if (e.key === "Enter") {
                  e.preventDefault();
                  addUrl();
                }
              }}
            />
            <Button
              isDisabled={!urlInput.trim()}
              variant="outline"
              onPress={addUrl}
            >
              <Link2 aria-hidden className="h-4 w-4" />
              {t("admin-products-images-add-url")}
            </Button>
          </div>
          {urlError && (
            <p className="text-xs text-danger" id={`${uid}-url-error`}>
              {urlError}
            </p>
          )}
        </div>
      )}

      {uploading && (
        <p className="mt-3 text-sm text-bx-ink-soft">
          {t("admin-products-images-uploading", progress)}
        </p>
      )}
      {errors.length > 0 && (
        <ul className="mt-3 list-disc ps-5 text-sm text-danger" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <p aria-live="polite" className="sr-only">
        {status}
      </p>
    </fieldset>
  );
}
