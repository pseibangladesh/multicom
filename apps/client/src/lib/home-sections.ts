/**
 * Home page sections for the storefront (spec 2026-11-23-buy-now-page-builder §3).
 */
import { useQuery } from "@tanstack/react-query";

import { getHomeSections, type PublicHomeSection } from "@/lib/store-api";

/** Today's home page: what shows while loading, or if the request fails. */
export const DEFAULT_HOME_SECTIONS: PublicHomeSection[] = [
  { id: "builtin-banner", type: "banner", title: null },
  { id: "builtin-catalogue", type: "catalogue", title: null },
];

export function useHomeSections(enabled = true) {
  const query = useQuery<PublicHomeSection[], Error>({
    queryKey: ["home-sections"],
    queryFn: getHomeSections,
    enabled,
    staleTime: 60 * 1000,
    retry: 1,
  });

  return {
    ...query,
    sections: query.data ?? DEFAULT_HOME_SECTIONS,
  };
}
