/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { useEffect, useMemo, useState } from "react";

import {
  BENGAL_THEME,
  MODE_STORAGE_KEY,
  createModeController,
  type ColorMode,
} from "@/lib/theme";

/** Same-tab broadcast so every useTheme instance follows a mode change. */
const MODE_CHANGED_EVENT = "bengal-exchange:mode-changed";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Puts the mode on <html>: the `light`/`dark` class, the Bengal theme and colour-scheme. */
function applyModeToDom(mode: ColorMode) {
  const root = document.documentElement;

  root.classList.remove("light", "dark");
  root.classList.add(mode);
  root.setAttribute("data-theme", BENGAL_THEME);
  root.style.colorScheme = mode;
}

function announce(mode: ColorMode) {
  applyModeToDom(mode);
  window.dispatchEvent(new CustomEvent(MODE_CHANGED_EVENT, { detail: mode }));
}

/** One controller per page: saves only explicit choices, otherwise follows the system. */
const controller =
  typeof window === "undefined"
    ? null
    : createModeController({
        storage: {
          get: (k) => {
            try {
              return localStorage.getItem(k);
            } catch {
              return null;
            }
          },
          set: (k, v) => {
            try {
              localStorage.setItem(k, v);
            } catch {
              // Private mode or blocked storage: the mode still applies for this visit.
            }
          },
          remove: (k) => {
            try {
              localStorage.removeItem(k);
            } catch {
              // storage unavailable: nothing to remove
            }
          },
        },
        prefersDark: () => {
          try {
            return window.matchMedia(DARK_QUERY).matches;
          } catch {
            return false;
          }
        },
        onSystemChange: (listener) => {
          try {
            const mq = window.matchMedia(DARK_QUERY);
            const handler = (e: MediaQueryListEvent) => listener(e.matches);

            mq.addEventListener("change", handler);

            return () => mq.removeEventListener("change", handler);
          } catch {
            return () => undefined;
          }
        },
        apply: announce,
      });

// A choice saved in another tab: the controller re-reads it, then every
// useTheme instance in this tab hears the change through announce().
if (controller) {
  window.addEventListener("storage", (e) => {
    if (e.key === MODE_STORAGE_KEY || e.key === null) controller.sync();
  });
  // Vite dev only: drop the old controller's system listener on hot reload.
  import.meta.hot?.dispose(() => controller.dispose());
}

/**
 * Light / dark mode for the Bengal theme.
 *
 * Saved in localStorage ("theme") only when the user picks Light or Dark;
 * until then the system setting decides, and later system changes are
 * followed. index.html applies the same rule before the first paint.
 */
export const useTheme = () => {
  const [theme, setTheme] = useState<ColorMode>(
    () => controller?.mode() ?? "light",
  );

  const isDark = useMemo(() => theme === "dark", [theme]);
  const isLight = useMemo(() => theme === "light", [theme]);

  useEffect(() => {
    const onLocal = (e: Event) =>
      setTheme((e as CustomEvent<ColorMode>).detail);

    window.addEventListener(MODE_CHANGED_EVENT, onLocal);
    const mode = controller?.mode() ?? "light";

    applyModeToDom(mode);
    setTheme(mode);

    return () => {
      window.removeEventListener(MODE_CHANGED_EVENT, onLocal);
    };
  }, []);

  const choose = (mode: ColorMode) => controller?.choose(mode);

  const setLightTheme = () => choose("light");
  const setDarkTheme = () => choose("dark");
  const toggleTheme = () => choose(theme === "dark" ? "light" : "dark");

  return { theme, isDark, isLight, setLightTheme, setDarkTheme, toggleTheme };
};
