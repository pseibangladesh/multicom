/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Loading state for the content area only: the storefront shell (header,
 * footer) stays visible with its own light or dark background.
 */

import { Spinner } from "@heroui/react";
import { useTranslation } from "react-i18next";

export function ContentLoading() {
  const { t } = useTranslation();

  return (
    <div
      aria-live="polite"
      className="flex min-h-[50vh] items-center justify-center"
      role="status"
    >
      <Spinner size="lg" />
      <span className="sr-only">{t("loading")}</span>
    </div>
  );
}
