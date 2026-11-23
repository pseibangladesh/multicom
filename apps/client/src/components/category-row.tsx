/**
 * "Shop by category": a horizontal, smoothly scrolling row of every category
 * shoppers can see, shown on the landing page under the banner. Each tile
 * links to that category's product list (/products?category=<handle>).
 *
 * Swipe or scroll on phones; Previous/Next buttons from tablet width up.
 * Works in RTL and honours reduced motion (same behaviour as ShowcaseRow).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Button } from "@heroui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { useCategoryTree, type CategoryTree } from "@/hooks/use-categories";
import { useDragScroll } from "@/hooks/use-drag-scroll";
import { resolveTitle } from "@/utils/description";

/** Parents first, each followed by its subcategories, all by position. */
function flatten(nodes: CategoryTree[]): CategoryTree[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Whether the row is at its start / end, direction-independent. */
function scrollState(el: HTMLElement) {
  const max = el.scrollWidth - el.clientWidth;
  // In RTL, scrollLeft runs from 0 to -max.
  const pos = Math.abs(el.scrollLeft);

  return { atStart: pos <= 1, atEnd: pos >= max - 1 };
}

export function CategoryRow() {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const scroller = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ atStart: true, atEnd: false });
  const { tree } = useCategoryTree();
  const categories = flatten(tree);

  useDragScroll(scroller, categories.length > 0);

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
  }, [update, categories.length]);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;

    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    el.scrollBy({
      left: el.clientWidth * 0.8 * direction * (rtl ? -1 : 1),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  if (categories.length === 0) return null;

  const title = t("shop-by-category");

  return (
    <section aria-labelledby={headingId} className="mx-auto max-w-7xl py-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <h2 className="font-display text-2xl text-bx-ink" id={headingId}>
          {title}
        </h2>
        <div className="hidden gap-2 md:flex">
          <Button
            isIconOnly
            aria-label={t("categories-previous")}
            isDisabled={ends.atStart}
            size="sm"
            variant="outline"
            onPress={() => page(-1)}
          >
            <ChevronLeft aria-hidden className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <Button
            isIconOnly
            aria-label={t("categories-next")}
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
        className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-3 overflow-x-auto px-1 pb-2 hide-scrollbar motion-safe:scroll-smooth md:cursor-grab"
        onScroll={update}
      >
        {categories.map((category) => {
          const name = resolveTitle(category.name, i18n.language);
          const image = category.thumbnail_url || category.image_url;

          return (
            <li key={category.id} className="w-24 shrink-0 snap-start sm:w-28">
              <RouterLink
                className="group flex flex-col items-center gap-2 rounded-xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-bx-accent"
                to={`/products?category=${encodeURIComponent(category.handle)}`}
              >
                <span className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-full border border-bx-line bg-bx-surface transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
                  {image ? (
                    <img
                      alt=""
                      className="h-full w-full object-cover"
                      decoding="async"
                      loading="lazy"
                      src={image}
                    />
                  ) : (
                    <span
                      aria-hidden
                      className="font-display text-2xl text-bx-ink-soft"
                    >
                      {name.trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 text-sm text-bx-ink group-hover:text-bx-accent">
                  {name}
                </span>
              </RouterLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
