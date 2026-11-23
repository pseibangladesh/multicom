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

import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Button, Spinner } from "@heroui/react";
import { useState, useEffect, useRef } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";

import {
  StoreProduct,
  searchProducts,
  getProductsPage,
  getCategoryProductsPage,
} from "@/lib/store-api";
import { ProductCard } from "@/components/product-card";
import { CategoryNav } from "@/components/category-nav";
import { HomeHero } from "@/components/home-hero";
import { useCategories } from "@/hooks/use-categories";
import { resolveTitle } from "@/utils/description";

export default function IndexPage() {
  const { t, i18n } = useTranslation();

  // Parse URL params — q for search, category for category filter
  const [searchParams] = useSearchParams();
  const term = searchParams.get("q") || "";
  const categoryHandle = searchParams.get("category") || "";
  const isLanding = !term && !categoryHandle;

  const gridRef = useRef<HTMLDivElement>(null);
  // Index of the first product added by "Load more": focus moves there once it renders.
  const [focusFrom, setFocusFrom] = useState<number | null>(null);

  // Resolve localised category name for the page heading
  const { data: categories } = useCategories();
  const categoryName = categoryHandle
    ? resolveTitle(
        categories?.find((c) => c.handle === categoryHandle)?.name ??
          categoryHandle,
        i18n.language,
      )
    : "";

  // Search mode — active when ?q= is present
  const {
    data: searchData,
    isLoading: searchLoading,
    isError: searchError,
  } = useQuery<StoreProduct[], Error>({
    queryKey: ["search", term],
    queryFn: () => searchProducts(term),
    enabled: !!term,
  });

  // Category mode — active when ?category= is present (and no search term)
  const {
    data: categoryData,
    hasNextPage: categoryHasNextPage,
    fetchNextPage: categoryFetchNextPage,
    isFetchingNextPage: categoryIsFetchingNextPage,
    isLoading: categoryLoading,
    isError: categoryError,
  } = useInfiniteQuery({
    queryKey: ["category-products", categoryHandle],
    queryFn: ({ pageParam }) =>
      getCategoryProductsPage(categoryHandle, pageParam as string | null),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.has_more
        ? lastPage.pagination.next_cursor
        : undefined,
    enabled: !!categoryHandle && !term,
  });

  // Browse mode — active when no search term and no category
  const {
    data: browseData,
    hasNextPage: browseHasNextPage,
    fetchNextPage: browseFetchNextPage,
    isFetchingNextPage: browseIsFetchingNextPage,
    isLoading: browseLoading,
    isError: browseError,
  } = useInfiniteQuery({
    queryKey: ["products"],
    queryFn: ({ pageParam }) => getProductsPage(pageParam as string | null),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.has_more
        ? lastPage.pagination.next_cursor
        : undefined,
    enabled: !term && !categoryHandle,
  });

  const safeProducts: StoreProduct[] = term
    ? (searchData ?? [])
    : categoryHandle
      ? (categoryData?.pages.flatMap((p) => p.items) ?? [])
      : (browseData?.pages.flatMap((p) => p.items) ?? []);

  const productsLoading = term
    ? searchLoading
    : categoryHandle
      ? categoryLoading
      : browseLoading;
  const productsError = term
    ? searchError
    : categoryHandle
      ? categoryError
      : browseError;
  const hasNextPage = categoryHandle ? categoryHasNextPage : browseHasNextPage;
  const fetchNextPage = categoryHandle
    ? categoryFetchNextPage
    : browseFetchNextPage;
  const isFetchingNextPage = categoryHandle
    ? categoryIsFetchingNextPage
    : browseIsFetchingNextPage;

  const [selectedVariants, setSelectedVariants] = useState<
    Record<string, string>
  >({});

  const handleVariantChange = (productId: string, sku: string) => {
    setSelectedVariants((prev) => ({ ...prev, [productId]: sku }));
  };

  // "Load more" instead of infinite scroll, so the footer stays reachable.
  const loadMore = () => {
    setFocusFrom(safeProducts.length);
    void fetchNextPage();
  };

  useEffect(() => {
    if (focusFrom === null || safeProducts.length <= focusFrom) return;
    const links = gridRef.current?.querySelectorAll<HTMLAnchorElement>(
      'a:not([aria-hidden="true"])',
    );

    links?.[focusFrom]?.focus();
    setFocusFrom(null);
  }, [focusFrom, safeProducts.length]);

  return (
    <>
      {isLanding && <HomeHero />}
      <div className="mx-auto flex max-w-7xl gap-6 py-6">
        {/* Sidebar — categories navigation (hidden on mobile) */}
        <aside className="hidden md:block w-56 shrink-0">
          <CategoryNav showImages={false} />
        </aside>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Page heading: on the landing page the hero owns the <h1>. */}
          {isLanding ? (
            <h2
              className="mb-6 scroll-mt-24 font-display text-3xl text-bx-ink"
              id="catalogue"
            >
              {t("shop-products-title")}
            </h2>
          ) : (
            <h1 className="mb-6 font-display text-3xl text-bx-ink">
              {term ? t("search-results-for", { term }) : categoryName}
            </h1>
          )}

          {/* State: loading */}
          {productsLoading && (
            <div className="flex justify-center items-center py-20">
              <Spinner size="lg" />
            </div>
          )}

          {/* State: error */}
          {productsError && !productsLoading && (
            <p className="text-center text-danger">{t("products-error")}</p>
          )}

          {/* State: empty */}
          {!productsLoading && !productsError && safeProducts.length === 0 && (
            <p className="text-center text-default-500">
              {t("admin-products-empty")}
            </p>
          )}

          {/* Product grid */}
          {safeProducts.length > 0 && (
            <>
              <div
                ref={gridRef}
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
              >
                {safeProducts.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    selectedSku={selectedVariants[product.id]}
                    onSelectVariant={handleVariantChange}
                    categoryHandle={categoryHandle || undefined}
                  />
                ))}
              </div>

              {!term && hasNextPage && (
                <div className="mt-8 flex justify-center">
                  <Button
                    isPending={isFetchingNextPage}
                    variant="outline"
                    onPress={loadMore}
                  >
                    {t("catalogue-load-more")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
