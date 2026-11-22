/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * StoreThemeProvider — puts the single Bengal theme on <html>.
 * Light/dark is handled by hooks/use-theme.ts.
 */

import type React from "react";

import { useEffect } from "react";

import { BENGAL_THEME } from "@/lib/theme";

/**
 * Applies the single Bengal theme. Older slugs (classic, luxury, luxury-dark,
 * default) stored in localStorage or user preferences are ignored: they all
 * resolve to bengal (see lib/theme.ts). Light/dark mode is handled by
 * hooks/use-theme.ts.
 */
export function StoreThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", BENGAL_THEME);
  }, []);

  return <>{children}</>;
}
