/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Admin Categories Management Page
 * Displays the CategoryAdmin component for managing product categories
 */

import { useTranslation } from "react-i18next";

import { CategoryAdmin } from "@/components/category-admin";

export default function CategoriesPage() {
  const { t } = useTranslation();

  return (
    <>
      <div className="min-h-screen  py-8">
        <div className="mx-auto max-w-7xl lg:px-8">
          <div className="mb-8">
            <h1 className="text-2xl md:text-3xl font-bold text-foreground">
              {t("categories")}
            </h1>
            <p className="mt-2 text-default-500">
              {t("manage-product-categories")}
            </p>
          </div>
          <CategoryAdmin />
        </div>
      </div>
    </>
  );
}
