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

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";

import { useAuth } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import {
  browserStorage,
  mergeCarts,
  purgeLegacyCarts,
  readCart,
  writeCart,
  type CartItem,
} from "@/lib/cart-storage";

/**
 * The shopping cart, shared by the header, product cards and cart page.
 *
 * - Signed out: kept in this browser (guest cart).
 * - Signed in: kept on the server (/v1/me/cart) for the account, so it is the
 *   same on every device and nothing of it stays in a shared browser. Items
 *   added while signed out are moved into the account's cart on sign-in.
 */

/**
 * Shape of the cart context value provided by {@link CartProvider}.
 */
type CartContextType = {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  updateQuantity: (sku: string, qty: number) => void;
  removeItem: (sku: string) => void;
  clear: () => void;
  count: number;
  totalCents: number;
};

const CartContext = createContext<CartContextType | undefined>(undefined);

/** Where `items` is saved: this browser, or the signed-in account. */
type Owner = { kind: "guest" } | { kind: "account" };

const SAVE_DELAY_MS = 400;

/** What the server accepts (at most 100 lines, 1–999 each). */
const forServer = (items: CartItem[]) =>
  items
    .slice(0, 100)
    .map((i) => ({ ...i, qty: Math.min(Math.max(1, i.qty), 999) }));

/**
 * Context provider that manages the global shopping cart state.
 * Must sit inside the authentication provider.
 *
 * @example
 * ```tsx
 * <CartProvider>
 *   <App />
 * </CartProvider>
 * ```
 */
export const CartProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const auth = useAuth();
  const { isLoading: authLoading } = auth;
  const userId = authLoading ? null : (auth.user?.id ?? null);
  const apiBase = getApiBase();
  // getJson/putJson change identity every render; read them through a ref.
  const authRef = useRef(auth);

  authRef.current = auth;

  // null until we know whose cart this is, so nothing is shown to or saved
  // for the wrong person meanwhile.
  const [owner, setOwner] = useState<Owner | null>(null);
  const [items, setItems] = useState<CartItem[]>([]);
  // The account cart as last saved to the server, to skip no-op saves.
  const savedJson = useRef<string>("");

  // Load the cart whenever the browsing user changes.
  useEffect(() => {
    if (authLoading) return;
    const storage = browserStorage();

    purgeLegacyCarts(storage);
    if (!userId) {
      setItems(readCart(storage));
      setOwner({ kind: "guest" });

      return;
    }

    let cancelled = false;

    setOwner(null);
    (async () => {
      try {
        const data = (await authRef.current.getJson(
          `${apiBase}/v1/me/cart`,
        )) as {
          items?: CartItem[];
        };
        const server = data.items ?? [];
        const guest = readCart(storage);
        const merged = guest.length > 0 ? mergeCarts(server, guest) : server;

        if (guest.length > 0) {
          await authRef.current.putJson(`${apiBase}/v1/me/cart`, {
            items: forServer(merged),
          });
        }
        writeCart(storage, []); // the guest items now belong to the account
        if (cancelled) return;
        savedJson.current = JSON.stringify(forServer(merged));
        setItems(merged);
        setOwner({ kind: "account" });
      } catch (err) {
        // Account cart unreachable (offline, email not verified…): keep using
        // the browser cart rather than showing an empty one.
        console.error("[Cart] Could not load the account cart:", err);
        if (cancelled) return;
        setItems(readCart(storage));
        setOwner({ kind: "guest" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, userId, apiBase]);

  // Save changes: to the browser for guests, to the server for accounts.
  useEffect(() => {
    if (!owner) return;
    if (owner.kind === "guest") {
      writeCart(browserStorage(), items);

      return;
    }
    const body = forServer(items);
    const json = JSON.stringify(body);

    if (json === savedJson.current) return;
    const save = () => {
      savedJson.current = json;
      authRef.current
        .putJson(`${apiBase}/v1/me/cart`, { items: body })
        .catch((err: unknown) => {
          savedJson.current = "";
          console.error("[Cart] Could not save the cart:", err);
        });
    };
    const timer = setTimeout(save, SAVE_DELAY_MS);
    // Leaving the page before the timer fires: send it anyway.
    const onPageHide = () => {
      clearTimeout(timer);
      savedJson.current = json;
      void fetch(`${apiBase}/v1/me/cart`, {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: body }),
      }).catch(() => {});
    };

    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [owner, items, apiBase]);

  const addItem = useCallback((item: CartItem) => {
    setItems((prev) => {
      const existing = prev.find((i) => i.sku === item.sku);

      if (existing) {
        return prev.map((i) =>
          i.sku === item.sku
            ? {
                ...i,
                qty: i.qty + item.qty,
                currency: item.currency ?? i.currency,
              }
            : i,
        );
      }

      return [...prev, item];
    });
  }, []);

  const updateQuantity = useCallback((sku: string, qty: number) => {
    setItems((prev) => {
      if (qty <= 0) {
        return prev.filter((i) => i.sku !== sku);
      }

      return prev.map((i) => (i.sku === sku ? { ...i, qty } : i));
    });
  }, []);

  const removeItem = useCallback((sku: string) => {
    setItems((prev) => prev.filter((i) => i.sku !== sku));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const count = items.reduce((sum, i) => sum + i.qty, 0);
  const totalCents = items.reduce((sum, i) => sum + i.price_cents * i.qty, 0);

  const value: CartContextType = {
    items,
    addItem,
    updateQuantity,
    removeItem,
    clear,
    count,
    totalCents,
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
};

/**
 * Returns the current cart context.
 * Must be called inside a {@link CartProvider}; throws otherwise.
 *
 * @returns The {@link CartContextType} value with items, totals, and mutation helpers.
 * @throws {Error} When called outside of a `<CartProvider>` tree.
 */
export function useCart(): CartContextType {
  const ctx = useContext(CartContext);

  if (!ctx) {
    throw new Error("useCart must be used within a CartProvider");
  }

  return ctx;
}
