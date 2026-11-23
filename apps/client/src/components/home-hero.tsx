import { buttonVariants } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";

import { useCategories } from "@/hooks/use-categories";

/** Marketplaces named in the hero copy (brand names, not translated). */
const MARKETPLACES = "Amazon · Etsy · eBay";

/**
 * Landing-page banner (Bengal mock "hero"). Shown only on the plain shop
 * landing page; it owns the page's <h1>, so the catalogue heading below
 * becomes an <h2 id="catalogue">, which "Shop all products" jumps to.
 */
export function HomeHero() {
  const { t } = useTranslation();
  const { data: categories } = useCategories();

  return (
    <section
      aria-labelledby="home-hero-title"
      className="mb-10 grid items-end gap-8 border-b border-bx-line pb-10 pt-4 md:mb-12 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:gap-16 md:pb-14 md:pt-10"
    >
      <div>
        <h1
          className="font-display text-[2.5rem] leading-[1.05] tracking-tight text-bx-ink text-balance md:text-6xl lg:text-7xl"
          id="home-hero-title"
        >
          {t("home-hero-title")}
        </h1>
        <p className="mt-5 max-w-[44ch] text-lg text-bx-ink-soft">
          {t("home-hero-text")}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            className={buttonVariants({ variant: "primary", size: "lg" })}
            href="#catalogue"
          >
            {t("home-hero-shop-all")}
          </a>
          <RouterLink
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/products"
          >
            {t("home-hero-browse-categories")}
          </RouterLink>
        </div>
      </div>

      <ul
        aria-label={t("home-hero-glance")}
        className="border-t border-bx-line"
      >
        <li className="flex items-baseline justify-between gap-4 border-b border-bx-line py-4 text-bx-ink-soft">
          <span>{t("home-hero-marketplaces")}</span>
          <strong className="font-display text-xl font-normal text-bx-ink">
            {MARKETPLACES}
          </strong>
        </li>
        <li className="flex items-baseline justify-between gap-4 border-b border-bx-line py-4 text-bx-ink-soft">
          <span>{t("home-hero-categories")}</span>
          {/* Fixed-height slot so the row doesn't move when the count arrives. */}
          <strong className="min-h-7 font-display text-xl font-normal tabular-nums text-bx-ink">
            {categories ? categories.length : ""}
          </strong>
        </li>
      </ul>
    </section>
  );
}
