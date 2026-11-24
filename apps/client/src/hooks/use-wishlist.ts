/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/authentication";
import { getApiBase } from "@/lib/api-base";

/**
 * Return value of the {@link useWishlist} hook.
 */
export interface UseWishlistReturn {
  wishlist: string[];
  isLoading: boolean;
  isError: boolean;
  toggle: (productId: string) => Promise<void>;
  isFavorite: (productId: string) => boolean;
}

/** Query key of a user's wishlist (per user, so accounts never share a cache). */
export const wishlistKey = (userId: string | undefined) =>
  ["me", userId, "wishlist"] as const;

/**
 * The signed-in customer's wishlist (product ids), stored on the server
 * (GET/POST/DELETE /v1/me/wishlist), so it is the same on every device.
 * Empty when signed out.
 */
export function useWishlist(): UseWishlistReturn {
  const auth = useAuth();
  const apiBase = getApiBase();
  const queryClient = useQueryClient();
  const userId = auth.user?.id;
  const key = wishlistKey(userId);

  const query = useQuery<string[], Error>({
    queryKey: key,
    queryFn: async () => {
      const data = (await auth.getJson(`${apiBase}/v1/me/wishlist`)) as {
        wishlist?: string[];
      };

      return data.wishlist ?? [];
    },
    enabled: auth.isAuthenticated && !!userId,
    staleTime: 60_000,
  });
  const wishlist = auth.isAuthenticated ? (query.data ?? []) : [];

  const mutation = useMutation<string[], Error, string>({
    mutationFn: async (productId) => {
      const data = (
        wishlist.includes(productId)
          ? await auth.deleteJson(
              `${apiBase}/v1/me/wishlist/${encodeURIComponent(productId)}`,
            )
          : await auth.postJson(`${apiBase}/v1/me/wishlist`, { productId })
      ) as { wishlist?: string[] };

      return data.wishlist ?? [];
    },
    onSuccess: (next) => queryClient.setQueryData(key, next),
    onError: (error) =>
      console.error("[useWishlist] Could not update the wishlist:", error),
  });

  const toggle = useCallback(
    async (productId: string) => {
      if (!auth.isAuthenticated) return;
      await mutation.mutateAsync(productId).catch(() => {});
    },
    [auth.isAuthenticated, mutation],
  );

  const isFavorite = useCallback(
    (productId: string) => wishlist.includes(productId),
    [wishlist],
  );

  return {
    wishlist,
    isLoading: auth.isAuthenticated && (query.isLoading || mutation.isPending),
    isError: query.isError,
    toggle,
    isFavorite,
  };
}
