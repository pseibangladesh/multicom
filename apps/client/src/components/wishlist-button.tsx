/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { Button, Tooltip } from "@heroui/react";
import { Heart } from "lucide-react";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useWishlist } from "@/hooks/use-wishlist";
import { useAuth } from "@/authentication";
import { LoginModal } from "@/features/auth/components/login-modal";

interface WishlistButtonProps {
  productId: string;
  size?: "sm" | "md" | "lg";
  isIconOnly?: boolean;
}

/**
 * WishlistButton — Heart toggle button to add/remove a product from favorites
 *
 * Shows a filled heart if the product is in the wishlist, empty otherwise.
 * Requires authentication; will show a login prompt if not authenticated.
 *
 * Workflow:
 * - Authenticated: Click heart → POST /v1/me/wishlist → Token refresh → Heart red
 * - Not authenticated: Click heart → LoginModal → Login → POST /v1/me/wishlist → Heart red
 *
 * The pending action is preserved across login via sessionStorage.
 *
 * Usage:
 * ```tsx
 * <WishlistButton productId="prod_123" />
 * ```
 */
export function WishlistButton({
  productId,
  size = "md",
  isIconOnly = true,
}: WishlistButtonProps) {
  const { t } = useTranslation();
  const { isFavorite, toggle, isLoading } = useWishlist();
  const { isAuthenticated } = useAuth();
  const [loginModalOpen, setLoginModalOpen] = useState(false);

  const isFav = isFavorite(productId);

  const tooltipContent = isFav
    ? t("remove-from-wishlist")
    : t("add-to-wishlist");

  const onWishlistToggle = () => {
    if (!isAuthenticated) {
      setLoginModalOpen(true);

      return;
    }

    toggle(productId);
  };

  /**
   * Detect if there's a pending wishlist action after auth redirect
   * and execute the toggle immediately
   */
  useEffect(() => {
    if (!isAuthenticated) return;

    const pendingItem = sessionStorage.getItem("pendingWishlistProduct");

    if (pendingItem && pendingItem === productId && !isFav) {
      // Trigger the wishlist addition for the product
      toggle(productId);
      // Clean up the sessionStorage
      sessionStorage.removeItem("pendingWishlistProduct");
    }
  }, [isAuthenticated, productId, isFav, toggle]);

  return (
    <>
      {/* The Button is the tooltip trigger itself: no wrapper element, so no
          nested interactive control, and it carries its own accessible name. */}
      <Tooltip>
        <Button
          aria-label={tooltipContent}
          aria-pressed={isFav}
          isIconOnly={isIconOnly}
          className={`${
            isFav ? "text-red-500" : "text-default-400"
          } hover:text-red-500 transition-colors`}
          variant="tertiary"
          size={size}
          isPending={isLoading}
          onPress={onWishlistToggle}
        >
          <Heart
            aria-hidden
            className="w-5 h-5"
            fill={isFav ? "currentColor" : "none"}
            strokeWidth={2}
          />
        </Button>
        <Tooltip.Content>{tooltipContent}</Tooltip.Content>
      </Tooltip>

      <LoginModal
        isOpen={loginModalOpen}
        onClose={() => setLoginModalOpen(false)}
        pendingWishlistProduct={productId}
      />
    </>
  );
}
