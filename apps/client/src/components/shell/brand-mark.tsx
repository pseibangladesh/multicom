/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";

/** Diamond mark + serif "Bengali Exchange" wordmark, linking home. */
export function BrandMark({ className = "" }: { className?: string }) {
  const { t } = useTranslation();

  return (
    <RouterLink
      aria-label={t("brand-home")}
      className={`bx-wordmark ${className}`}
      to="/"
    >
      <svg aria-hidden="true" className="bx-mark" viewBox="0 0 24 24">
        <path
          d="M12 2 22 12 12 22 2 12Z"
          fill="none"
          opacity=".9"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M12 7 17 12 12 17 7 12Z" fill="var(--bx-accent)" />
      </svg>
      <span className="bx-wordmark-text">Bengali Exchange</span>
    </RouterLink>
  );
}
