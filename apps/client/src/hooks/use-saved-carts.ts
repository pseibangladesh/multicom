/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/authentication";
import { getApiBase } from "@/lib/api-base";

export interface SavedCartSnapshot {
  id: string;
  items: Array<{
    sku: string;
    title: string;
    qty: number;
    unit_price_cents: number;
  }>;
  totals: {
    subtotal_cents: number;
    discount_cents: number;
    shipping_cents: number;
    tax_cents: number;
    total_cents: number;
  };
  currency: string;
  customer_email: string;
  status: "open" | "checked_out" | "expired";
  expires_at: string;
  saved_at: string;
}

export interface UseSavedCartsReturn {
  savedCarts: SavedCartSnapshot[];
  isLoading: boolean;
  isError: boolean;
  toggleSavedCart: (cartId: string) => Promise<void>;
  isSaved: (cartId: string) => boolean;
  getSavedCart: (cartId: string) => SavedCartSnapshot | undefined;
}

/** Query key of a user's saved carts (per user, so accounts never share a cache). */
export const savedCartsKey = (userId: string | undefined) =>
  ["me", userId, "saved-carts"] as const;

/**
 * The signed-in customer's saved carts, stored on the server
 * (GET/POST/DELETE /v1/me/saved-carts), so they are the same on every device.
 * Empty when signed out.
 */
export function useSavedCarts(): UseSavedCartsReturn {
  const auth = useAuth();
  const apiBase = getApiBase();
  const queryClient = useQueryClient();
  const userId = auth.user?.id;
  const key = savedCartsKey(userId);

  const query = useQuery<SavedCartSnapshot[], Error>({
    queryKey: key,
    queryFn: async () => {
      const data = (await auth.getJson(`${apiBase}/v1/me/saved-carts`)) as {
        saved_carts?: SavedCartSnapshot[];
      };

      return data.saved_carts ?? [];
    },
    enabled: auth.isAuthenticated && !!userId,
    staleTime: 60_000,
  });
  const savedCarts = auth.isAuthenticated ? (query.data ?? []) : [];

  const isSaved = useCallback(
    (cartId: string) => savedCarts.some((sc) => sc.id === cartId),
    [savedCarts],
  );

  const mutation = useMutation<void, Error, string>({
    mutationFn: async (cartId) => {
      if (isSaved(cartId)) {
        await auth.deleteJson(
          `${apiBase}/v1/me/saved-carts/${encodeURIComponent(cartId)}`,
        );
      } else {
        await auth.postJson(`${apiBase}/v1/me/saved-carts`, { cartId });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (error) =>
      console.error("[useSavedCarts] Could not update saved carts:", error),
  });

  const toggleSavedCart = useCallback(
    async (cartId: string) => {
      if (!auth.isAuthenticated) return;
      await mutation.mutateAsync(cartId).catch(() => {});
    },
    [auth.isAuthenticated, mutation],
  );

  const getSavedCart = useCallback(
    (cartId: string) => savedCarts.find((sc) => sc.id === cartId),
    [savedCarts],
  );

  return {
    savedCarts,
    isLoading: auth.isAuthenticated && (query.isLoading || mutation.isPending),
    isError: query.isError,
    toggleSavedCart,
    isSaved,
    getSavedCart,
  };
}
