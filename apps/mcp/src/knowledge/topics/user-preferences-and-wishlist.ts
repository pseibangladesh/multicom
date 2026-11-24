/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */
import type { Topic } from '../base.js';
import { BASE_SYSTEM, appendFacts } from '../base.js';

const topic: Topic = {
  name: 'user-preferences-and-wishlist',
  description: 'Per-customer state on the server — wishlist, saved carts, the account cart and preferences under /v1/me/*, and the React Query hooks that use them.',
  tags: ["account","auth","security","user"],
  sources: [
    'apps/client/src/hooks/use-wishlist.ts',
  ],
  systemPrompt: BASE_SYSTEM,
  manualFacts: [
    'All per-customer state lives in the database, keyed by the signed-in session, so it is the same on every device. Routes use customerAuthMiddleware + resolveCustomer(); a customer can only ever reach their own data.',
    'Wishlist: customers.metadata.wishlist (string[] of product ids). GET /v1/me/wishlist, POST /v1/me/wishlist { productId }, DELETE /v1/me/wishlist/:productId; writes return { wishlist }.',
    'useWishlist() (apps/client/src/hooks/use-wishlist.ts) is a React Query hook keyed ["me", userId, "wishlist"]. Returns { wishlist, isLoading, isError, toggle(productId), isFavorite(productId) }. Signed out it returns an empty list.',
    'Saved carts: snapshots in customers.metadata. GET /v1/me/saved-carts returns { saved_carts } newest first; POST /v1/me/saved-carts saves a cart (it must belong to the customer\'s email); DELETE /v1/me/saved-carts/:cartId. Hook: useSavedCarts().',
    'Account cart: the customer_carts table (one row per customer). GET /v1/me/cart and PUT /v1/me/cart { items } (max 100 lines, qty 1–999). CartProvider (apps/client/src/hooks/use-cart.tsx) loads it on sign-in, merges the guest cart into it, and saves changes (debounced 400 ms). Guests keep their cart in localStorage only.',
    'Preferences: GET /v1/me/preferences and PUT /v1/me/preferences, stored on the customer record.',
  ],
  buildPrompt: (src) => appendFacts(`
Below is use-wishlist.ts.

${src}

Task: Write a "User Preferences & Wishlist Reference".
Include:
1. Wishlist storage: where data lives (customers.metadata) and the /v1/me/wishlist endpoints.
2. useWishlist() hook: all return values, usage example with heart-button toggle.
3. The account cart: /v1/me/cart and how the guest cart is merged on sign-in.
4. Saved cart: storage location, endpoints, auto-save behaviour.
5. CartProvider integration with saved-cart API.
6. User preferences: endpoints, what fields are stored.
`, topic.manualFacts),
};

export default topic;
