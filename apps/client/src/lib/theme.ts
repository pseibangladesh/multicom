/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Theme resolution for the Bengal design. There is one theme ("bengal") with a
 * light and a dark mode. Older theme slugs (classic, luxury, luxury-dark,
 * default, heroui_standard) may still be stored in user preferences, browser
 * storage or env values; they all resolve to bengal.
 */

export const BENGAL_THEME = "bengal" as const;

/** localStorage key holding the colour mode ("light" | "dark"). */
export const MODE_STORAGE_KEY = "theme";

export type ColorMode = "light" | "dark";

/** The stored mode wins; anything else falls back to the system preference. */
export function resolveMode(
  stored: string | null,
  prefersDark: boolean,
): ColorMode {
  if (stored === "light" || stored === "dark") return stored;

  return prefersDark ? "dark" : "light";
}

export interface ModeControllerDeps {
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  prefersDark(): boolean;
  /** Subscribe to system light/dark changes; returns an unsubscribe function. */
  onSystemChange(listener: (dark: boolean) => void): () => void;
  apply(mode: ColorMode): void;
}

/**
 * Light/dark state. The mode is saved only when the user chooses one; until
 * then it follows the system setting, including later changes.
 */
export function createModeController(deps: ModeControllerDeps) {
  migrateLegacyTheme(deps.storage);
  const saved = () => {
    const v = deps.storage.get(MODE_STORAGE_KEY);

    return v === "light" || v === "dark" ? v : null;
  };
  let current: ColorMode = resolveMode(saved(), deps.prefersDark());

  const unsubscribe = deps.onSystemChange((dark) => {
    if (saved() !== null) return;
    current = dark ? "dark" : "light";
    deps.apply(current);
  });

  return {
    mode: () => current,
    choose(mode: ColorMode) {
      current = mode;
      deps.storage.set(MODE_STORAGE_KEY, mode);
      deps.apply(mode);
    },
    /** Re-read the saved choice (another tab may have changed it). */
    sync() {
      current = resolveMode(saved(), deps.prefersDark());
      deps.apply(current);
    },
    dispose: unsubscribe,
  };
}

/** localStorage key used by the retired luxury theme switcher. */
export const LEGACY_THEME_KEY = "ui-theme";

/**
 * The old luxury switcher stored "luxury-dark" in ui-theme while leaving
 * theme=light, so those visitors chose a dark page: keep them dark. Any other
 * old slug is dropped. Runs once; index.html applies the same rule.
 */
export function migrateLegacyTheme(storage: ModeControllerDeps["storage"]) {
  const legacy = storage.get(LEGACY_THEME_KEY);

  if (legacy === null) return;
  if (legacy.endsWith("-dark")) storage.set(MODE_STORAGE_KEY, "dark");
  storage.remove(LEGACY_THEME_KEY);
}
