/**
 * A horizontal row of products from a showcase section (Offers, New
 * collection, Hot picks…), built in Admin → Page builder.
 *
 * Swipe or scroll on phones (part of the next card shows, so it's clear the
 * row scrolls); Previous/Next buttons from tablet width up. No autoplay.
 * Works in RTL and honours reduced motion.
 *
 * Spec: docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md §3
 */
import type { PublicHomeSection } from "@/lib/store-api";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@heroui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { ProductCard } from "@/components/product-card";
import { useDragScroll } from "@/hooks/use-drag-scroll";
import { resolveTitle } from "@/utils/description";

const ITEM = "w-[44%] shrink-0 snap-start sm:w-[30%] md:w-[23%] lg:w-[18%]";

/** How far along the row is, as 0 (start) … 1 (end), direction-independent. */
function scrollState(el: HTMLElement) {
  const max = el.scrollWidth - el.clientWidth;
  // In RTL, scrollLeft runs from 0 to -max.
  const pos = Math.abs(el.scrollLeft);

  return { atStart: pos <= 1, atEnd: pos >= max - 1 };
}

export function ShowcaseRow({ section }: { section: PublicHomeSection }) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const scroller = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ atStart: true, atEnd: false });
  const [selected, setSelected] = useState<Record<string, string>>({});

  const title = resolveTitle(section.title ?? "", i18n.language);
  const products = section.products ?? [];

  useDragScroll(scroller, products.length > 0);

  const update = useCallback(() => {
    if (scroller.current) setEnds(scrollState(scroller.current));
  }, []);

  useEffect(() => {
    update();
    const el = scroller.current;

    if (!el) return;
    const ro = new ResizeObserver(update);

    ro.observe(el);

    return () => ro.disconnect();
  }, [update, products.length]);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;

    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    el.scrollBy({
      left: el.clientWidth * 0.9 * direction * (rtl ? -1 : 1),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  if (products.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mx-auto max-w-7xl py-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <h2 className="font-display text-2xl text-bx-ink" id={headingId}>
          {title}
        </h2>
        <div className="hidden gap-2 md:flex">
          <Button
            isIconOnly
            aria-label={t("showcase-previous", { title })}
            isDisabled={ends.atStart}
            size="sm"
            variant="outline"
            onPress={() => page(-1)}
          >
            <ChevronLeft aria-hidden className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button
            isIconOnly
            aria-label={t("showcase-next", { title })}
            isDisabled={ends.atEnd}
            size="sm"
            variant="outline"
            onPress={() => page(1)}
          >
            <ChevronRight aria-hidden className="h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>
      </div>
      <ul
        ref={scroller}
        className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-4 overflow-x-auto px-1 pb-2 hide-scrollbar motion-safe:scroll-smooth md:cursor-grab"
        onScroll={update}
      >
        {products.map((product) => (
          <li key={product.id} className={ITEM}>
            {/* No category passed on: the category is hidden from shoppers. */}
            <ProductCard
              product={product}
              selectedSku={selected[product.id]}
              onSelectVariant={(id, sku) =>
                setSelected((prev) => ({ ...prev, [id]: sku }))
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
