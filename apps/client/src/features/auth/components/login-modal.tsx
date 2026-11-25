/**
 * Copyright (c) 2026 Ronan LE MEILLAT
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

/**
 * Sign-in / create-account dialog. The shopper stays on the page they were on
 * (cart, checkout prompt, product), so what they were doing is kept.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@heroui/react";

import { EmailAuthForm, type AuthMode } from "./email-auth-form";

import { useAuth } from "@/authentication";
import BengalExchangeLogo from "@/assets/bengal_exchange_logo_02.svg";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Product to add to the wishlist once signed in (see WishlistButton). */
  pendingWishlistProduct?: string;
}

export function LoginModal({
  isOpen,
  onClose,
  pendingWishlistProduct,
}: LoginModalProps) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const [mode, setMode] = useState<AuthMode>("signin");
  const storeName = import.meta.env.STORE_NAME || "Bengali Exchange";

  // Every time it opens, start on "sign in".
  useEffect(() => {
    if (isOpen) setMode("signin");
  }, [isOpen]);

  if (isAuthenticated) return null;

  const signedIn = () => {
    if (pendingWishlistProduct) {
      try {
        sessionStorage.setItem(
          "pendingWishlistProduct",
          pendingWishlistProduct,
        );
      } catch {
        /* storage blocked: the shopper can tap the heart again */
      }
    }
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            {({ close }) => (
              <>
                <Modal.CloseTrigger onPress={close} />
                <Modal.Body className="flex flex-col items-center gap-4 px-6 pt-8 pb-7">
                  <div className="mb-1 flex flex-col items-center gap-1.5">
                    <div className="h-12 w-12 overflow-hidden rounded-xl bg-white shadow-sm">
                      <img
                        alt=""
                        className="h-full w-full object-cover"
                        src={BengalExchangeLogo}
                      />
                    </div>
                    <span className="text-xs font-medium tracking-wide text-bx-stone">
                      {storeName}
                    </span>
                  </div>

                  <div className="flex flex-col items-center gap-1.5 text-center">
                    <h2 className="font-display text-2xl text-bx-ink">
                      {mode === "signup"
                        ? t("login-signup-title")
                        : t("login-modal-title")}
                    </h2>
                    <p className="max-w-67.5 text-sm leading-snug text-bx-stone">
                      {mode === "signup"
                        ? t("login-signup-subtitle")
                        : t("login-modal-subtitle", { storeName })}
                    </p>
                  </div>

                  <EmailAuthForm
                    mode={mode}
                    onModeChange={setMode}
                    onSignedIn={signedIn}
                  />
                </Modal.Body>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
