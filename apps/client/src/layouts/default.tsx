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

import type React from "react";

import { createContext, useCallback, useContext, useState } from "react";
import { Outlet } from "react-router-dom";

import { CartDrawer } from "@/components/cart-drawer";
import { SideMenu } from "@/components/shell/side-menu";
import { SiteFooter } from "@/components/shell/site-footer";
import { SiteHeader } from "@/components/shell/site-header";
import { useCartDrawer } from "@/contexts/cart-drawer-context";
import { LoginModal } from "@/features/auth/components/login-modal";

/** True below a mounted shell, so a page's own <DefaultLayout> does not add a second one. */
const ShellContext = createContext(false);

/** Layout route: the shell stays mounted while the page inside changes. */
export function ShellRoute() {
  return (
    <DefaultLayout>
      <Outlet />
    </DefaultLayout>
  );
}

/**
 * Storefront shell: Bengal header, side menu, cart drawer, footer.
 * Pages still wrap themselves in <DefaultLayout>; under ShellRoute that
 * wrapper only renders its children.
 */
export default function DefaultLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const insideShell = useContext(ShellContext);

  if (insideShell) return <>{children}</>;

  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const {
    isOpen: isCartOpen,
    open: openCart,
    close: closeCart,
  } = useCartDrawer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <ShellContext.Provider value>
      <div className="relative flex min-h-dvh flex-col bg-[var(--bx-paper)] text-[var(--bx-ink)]">
        <SiteHeader
          menuOpen={menuOpen}
          onOpenCart={openCart}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <SideMenu
          isOpen={menuOpen}
          onClose={closeMenu}
          onLogin={() => setLoginOpen(true)}
        />
        <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
        <CartDrawer
          isOpen={isCartOpen}
          onClose={(v) => {
            if (!v) closeCart();
          }}
        />
        <main
          className="bx-wrap grow pb-16 pt-8 outline-none"
          id="main"
          tabIndex={-1}
        >
          {children}
        </main>
        <SiteFooter />
      </div>
    </ShellContext.Provider>
  );
}
