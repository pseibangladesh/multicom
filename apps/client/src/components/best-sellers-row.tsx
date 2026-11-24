/**
 * "Best sellers": the most-sold products in one horizontally scrolling row,
 * shown on the landing page under "Shop by category". Reuses ShowcaseRow, so
 * the cards, height and scrolling match the page-builder showcase rows.
 * Hidden until the shop has sales.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { ShowcaseRow } from "@/components/showcase-row";
import { getBestSellers, type StoreProduct } from "@/lib/store-api";

export function BestSellersRow() {
  const { t } = useTranslation();
  const { data: products } = useQuery<StoreProduct[], Error>({
    queryKey: ["best-sellers"],
    queryFn: () => getBestSellers(12),
    staleTime: 10 * 60 * 1000,
  });

  if (!products?.length) return null;

  return (
    <ShowcaseRow
      section={{
        id: "best-sellers",
        type: "showcase",
        title: t("best-sellers"),
        products,
      }}
    />
  );
}
