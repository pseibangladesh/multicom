/**
 * Admin → Languages (/admin/languages): which storefront languages shoppers
 * can pick, and the default for visitors who haven't chosen one.
 * The translations themselves are files in the client (src/locales/base).
 */
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@heroui/react";

import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { availableLanguages, languageDirection } from "@/lib/languages";

interface Settings {
  enabled: string[];
  default: string;
  supported: string[];
}

const CARD = "rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-6";

export default function LanguagesPage() {
  const { t } = useTranslation();
  const { getJson, putJson } = useSecuredApi();
  const api = getApiBase();
  const uid = useId();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState<string[]>([]);
  const [def, setDef] = useState("en-US");
  const [saved, setSaved] = useState<{
    enabled: string[];
    default: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = (await getJson(
          `${api}/v1/admin/settings/languages`,
        )) as Settings;

        setEnabled(s.enabled);
        setDef(s.default);
        setSaved({ enabled: s.enabled, default: s.default });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = (code: string, on: boolean) => {
    setNotice(null);
    setEnabled((cur) => (on ? [...cur, code] : cur.filter((c) => c !== code)));
  };

  const defaultInvalid = !enabled.includes(def);
  const dirty =
    saved !== null &&
    (saved.default !== def ||
      [...saved.enabled].sort().join() !== [...enabled].sort().join());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = (await putJson(`${api}/v1/admin/settings/languages`, {
        enabled,
        default: def,
      })) as Settings;

      setEnabled(s.enabled);
      setDef(s.default);
      setSaved({ enabled: s.enabled, default: s.default });
      setNotice(t("admin-languages-saved"));
      await queryClient.invalidateQueries({
        queryKey: ["storefront-settings"],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h1 className="font-display text-3xl text-bx-ink">
        {t("admin-languages-title")}
      </h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-bx-stone">
        {t("admin-languages-subtitle")}
      </p>

      {loading ? (
        <p className="text-sm text-bx-stone">{t("loading")}</p>
      ) : (
        <div className={CARD}>
          <fieldset>
            <legend className="mb-3 text-lg font-semibold text-bx-ink">
              {t("admin-languages-enabled")}
            </legend>
            <ul className="grid gap-2 sm:grid-cols-2">
              {availableLanguages.map((l) => {
                const id = `${uid}-${l.code}`;
                const isOn = enabled.includes(l.code);

                return (
                  <li key={l.code}>
                    <label
                      className="flex cursor-pointer items-center gap-3 rounded-md border border-bx-line px-3 py-2 hover:bg-bx-paper"
                      htmlFor={id}
                    >
                      <input
                        checked={isOn}
                        className="h-4 w-4 accent-bx-primary"
                        disabled={isOn && enabled.length === 1}
                        id={id}
                        type="checkbox"
                        onChange={(e) => toggle(l.code, e.target.checked)}
                      />
                      <span className="flex-1">
                        <span
                          dir={languageDirection(l.code)}
                          lang={l.code}
                          className="text-bx-ink"
                        >
                          {l.nativeName}
                        </span>
                        <span className="ml-2 font-mono text-xs text-bx-stone">
                          {l.code}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-bx-stone">
              {t("admin-languages-one-required")}
            </p>
          </fieldset>

          <div className="mt-6 flex flex-col gap-1 sm:max-w-xs">
            <label
              className="text-sm font-medium text-bx-ink"
              htmlFor={`${uid}-default`}
            >
              {t("admin-languages-default")}
            </label>
            <select
              aria-describedby={`${uid}-default-help`}
              aria-invalid={defaultInvalid || undefined}
              className="w-full rounded-md border border-bx-field-line bg-bx-surface px-3 py-2 text-sm text-bx-ink"
              id={`${uid}-default`}
              value={def}
              onChange={(e) => {
                setNotice(null);
                setDef(e.target.value);
              }}
            >
              {availableLanguages
                .filter((l) => enabled.includes(l.code) || l.code === def)
                .map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.nativeName}
                  </option>
                ))}
            </select>
            <p
              className={`text-xs ${defaultInvalid ? "text-danger" : "text-bx-stone"}`}
              id={`${uid}-default-help`}
            >
              {defaultInvalid
                ? t("admin-languages-default-invalid")
                : t("admin-languages-default-help")}
            </p>
          </div>

          {error && (
            <p className="mt-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 flex items-center gap-4">
            <Button
              isDisabled={!dirty || defaultInvalid || enabled.length === 0}
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
