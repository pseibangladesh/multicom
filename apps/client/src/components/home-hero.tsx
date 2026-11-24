import type { ReactNode } from "react";

import { buttonVariants } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";

import { useCategories } from "@/hooks/use-categories";
import { type BannerInput, useActiveBanner } from "@/lib/banners";
import { resolveTitle } from "@/utils/description";

/** Marketplaces named in the hero copy (brand names, not translated). */
const MARKETPLACES = "Amazon · Etsy · eBay";

const HERO_CLASS =
  "mb-10 grid items-end gap-8 border-b border-bx-line pb-10 pt-4 md:mb-12 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:gap-16 md:pb-14 md:pt-10";
const TITLE_CLASS =
  "font-display text-[2.5rem] leading-[1.05] tracking-tight text-bx-ink text-balance md:text-6xl lg:text-7xl";

/**
 * A banner button. In-site paths use the router; "/#id" on the home page is a
 * plain in-page jump; anything else is an external link.
 */
function CtaLink({
  href,
  primary,
  children,
}: {
  href: string;
  primary: boolean;
  children: ReactNode;
}) {
  const className = buttonVariants({
    variant: primary ? "primary" : "outline",
    size: "lg",
  });

  if (href.startsWith("/#")) {
    return (
      <a className={className} href={href.slice(1)}>
        {children}
      </a>
    );
  }
  if (href.startsWith("/")) {
    return (
      <RouterLink className={className} to={href}>
        {children}
      </RouterLink>
    );
  }

  return (
    <a className={className} href={href} rel="noopener noreferrer">
      {children}
    </a>
  );
}

function AtAGlance() {
  const { t } = useTranslation();
  const { data: categories } = useCategories();

  return (
    <ul aria-label={t("home-hero-glance")} className="border-t border-bx-line">
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
  );
}

/** Renders one admin-managed banner (also used as the live preview in Admin → Banners). */
export function BannerHero({
  banner,
  headingLevel = 1,
}: {
  banner: BannerInput;
  headingLevel?: 1 | 2;
}) {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const ctas = (
    [
      [banner.cta_primary_label, banner.cta_primary_href, true],
      [banner.cta_secondary_label, banner.cta_secondary_href, false],
    ] as const
  ).filter(([label, href]) => label && href);
  const description = resolveTitle(banner.description, lang);

  return (
    <section aria-labelledby="home-hero-title" className={HERO_CLASS}>
      <div>
        <Heading className={TITLE_CLASS} id="home-hero-title">
          {resolveTitle(banner.title, lang)}
        </Heading>
        {description && (
          <p className="mt-5 max-w-[44ch] text-lg text-bx-ink-soft">
            {description}
          </p>
        )}
        {ctas.length > 0 && (
          <div className="mt-8 flex flex-wrap gap-3">
            {ctas.map(([label, href, primary]) => (
              <CtaLink
                key={`${href}-${primary}`}
                href={href as string}
                primary={primary}
              >
                {resolveTitle(label as string, lang)}
              </CtaLink>
            ))}
          </div>
        )}
      </div>

      {banner.image_url ? (
        <img
          alt={resolveTitle(banner.image_alt, lang)}
          className="aspect-[4/3] w-full rounded-md border border-bx-line object-cover"
          decoding="async"
          fetchPriority="high"
          src={banner.image_url}
        />
      ) : (
        <AtAGlance />
      )}
    </section>
  );
}

/** The built-in banner, used when no banner is active. */
function DefaultHero() {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="home-hero-title" className={HERO_CLASS}>
      <div>
        <h1 className={TITLE_CLASS} id="home-hero-title">
          {t("home-hero-title")}
        </h1>
        <p className="mt-5 max-w-[44ch] text-lg text-bx-ink-soft">
          {t("home-hero-text")}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <CtaLink primary href="/#catalogue">
            {t("home-hero-shop-all")}
          </CtaLink>
          <CtaLink href="/products" primary={false}>
            {t("home-hero-browse-categories")}
          </CtaLink>
        </div>
      </div>
      <AtAGlance />
    </section>
  );
}

/**
 * Landing-page banner. Shows the first active banner from Admin → Banners,
 * or the built-in one. It owns the page's <h1>; the catalogue heading below
 * is <h2 id="catalogue">, which "/#catalogue" links jump to.
 */
export function HomeHero() {
  const { data: banner, isPending } = useActiveBanner();

  // Hold the space while we find out which banner to show, so the page below
  // doesn't jump when it arrives.
  if (isPending) {
    return (
      <div
        aria-hidden
        className="mb-10 min-h-[28rem] border-b border-bx-line md:mb-12 md:min-h-[24rem]"
      />
    );
  }

  return banner ? <BannerHero banner={banner} /> : <DefaultHero />;
}
