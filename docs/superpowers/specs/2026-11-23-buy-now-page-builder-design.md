# Buy now, page builder and showcase sections: design

**Date:** 2026-11-23 · **Status:** draft for owner approval
**Relation to earlier specs:** a new spec. It overrides parts of
`2026-11-23-bengal-redesign-design.md` and `claude/bengal-redesign-decisions.md`
(listed under "Spec sections this overrides"). Where they differ, this spec wins.

## Intent

1. Let a shopper buy one product straight away, the way Daraz's "Buy now" works,
   without touching what is in their cart.
2. Let the admin arrange the home page as a list of sections, reordered by drag
   and drop, like the WordPress widget builder.
3. Let the admin build home-page sections from categories ("Offers",
   "New collection", "Hot picks", or any other), shown as horizontal rows of
   products. These replace the planned label carousel.

## Goals

- **Buy now** next to Add to cart on the product page. It opens a checkout with
  only that product (selected variant, quantity adjustable there).
- The cart is never read or changed by Buy now: not when starting, not on
  success, not on failure or cancel. This holds for Stripe and SSLCommerz.
- Cart checkout behaves exactly as today.
- **Page builder** at `/admin/page-builder`: the home page's sections in order.
  Reorder by mouse, touch or keyboard; add, edit, hide and delete showcase
  sections.
- **Showcase sections** show a chosen category's products as a horizontally
  scrolling row, in the order set for that category.
- Categories marked **showcase-only** never appear to shoppers as categories:
  not in the category list or filter, the "at a glance" count, breadcrumbs,
  product data, the sitemap, or UCP.

## Non-goals

- No auto-playing carousel or slide animation.
- No "View all" page for a showcase section (its category is hidden, so there is
  nothing to link to). Rows show up to the section's product limit.
- No free-form page layout (columns, custom HTML blocks). Only the section types
  listed below.
- No change to how payments are verified, orders are created, or prices are
  calculated.

## Anti-goals

- Buy now that empties, merges into or adds to the cart.
- A showcase category reachable by a shopper as a category (a filter chip, a
  `?category=` link that works, a breadcrumb).
- Drag and drop that only works with a mouse.
- An empty showcase row on the home page (no products → section not rendered).
- Home page slower than today: rows below the fold lazy-load images and reserve
  their height (CLS < 0.1, LCP < 2.5 s still apply).

## Approaches (considered and chosen)

**Overlap with the carousel (decision 4):** the owner chose **A**: showcase
sections replace the label system. No `featured_label` column is added. The
three labels become three showcase-only categories, each with a section.
(B, keeping both, was rejected: two ways to feature products and a backend field
that duplicates categories.)

**Buy now checkout:**
- *Chosen:* a separate page `/buy-now?product=…&sku=…&qty=…` that reuses the checkout steps
  split out of `cart.tsx`, and creates its own server cart with one item.
- *Rejected:* putting the item into the shopper's cart and checking out from
  there (changes the cart); passing a "mode" flag through `cart.tsx` (the page
  would mix two jobs and cart checkout would be at risk of changing).

**Telling a Buy now payment apart on return:**
- *Chosen:* record it on the server cart (`carts.source = 'buy_now'`). Stripe's
  return URLs are set by the client and carry `source=buy_now`; SSLCommerz
  returns are built by the server, which looks the cart up by transaction id.
- *Rejected:* a `sessionStorage` marker only (breaks if the payment page opens in
  another tab or the marker goes stale after an abandoned Buy now).

**Drag and drop:** see "Page builder" below.

## Design

### 1. Buy now

**Product page** (`product-card-full.tsx`): a secondary button "Buy now" beside
Add to cart. Same disabled rule as Add to cart (`out_of_stock`); label
"Pre-order now" for `preorder`. It navigates to
`/buy-now?product=<product id>&sku=<selected variant sku>&qty=1`. It does not call `useCart`.

**Checkout steps split out of `cart.tsx`:** a new component
`components/checkout/checkout-flow.tsx` takes over everything from "Checkout"
onwards: email, the sign-in prompt, saved addresses / address form, shipping
rate, payment method, redirect to the gateway. Props:

| Prop | Purpose |
|---|---|
| `items: {sku, qty}[]` | what the server cart is created with |
| `source: 'cart' \| 'buy_now'` | sent when creating the server cart; chooses return URLs |
| `cancelUrl: string` | Stripe cancel URL (today: the current page) |
| `onBack()` | leaves the flow (cart: back to the item list) |

`cart.tsx` keeps the item list, quantities, totals and Save cart, and renders
`<CheckoutFlow items={cart items} source="cart" …/>` where the inline steps are
today. The steps' markup, text and order stay identical. A regression e2e test
covers cart checkout before and after the split.

**Buy now page** (`pages/buy-now.tsx`, lazy route `/buy-now`):
- Loads the product by `product` and picks the variant by `sku`, shows one line: image, title,
  variant (colour/size), unit price, a quantity stepper (1 to 99), line total.
- Unknown product or a `sku` not in it, inactive or out-of-stock variant → a message and a
  link back to the product (or home if the product is unknown).
- Below it, `<CheckoutFlow items={[{sku, qty}]} source="buy_now"
  cancelUrl={this page's URL} …/>`.
- Shows the payment-failed/cancelled message when `?payment=failed|cancelled`
  (same `paymentReturnMessageKey` as the cart).
- Header and side menu are unchanged; the cart count still shows the cart.

**Backend:**
- `carts.source TEXT NOT NULL DEFAULT 'cart' CHECK (source IN ('cart','buy_now'))`
  (schema + inline migration `042_carts_add_source` + `migrations/042-…sql`).
- `CreateCartBody.source` optional, default `cart`; returned on the cart.
- Stripe: unchanged on the server. The client passes
  `success_url = /success?session_id={CHECKOUT_SESSION_ID}&source=buy_now` and
  `cancel_url = /buy-now?product=…&sku=…&qty=…`.
- SSLCommerz: `GET|POST /v1/webhooks/sslcommerz/return/:result` looks up the
  cart by `sslcommerz_tran_id`. If `source = 'buy_now'`:
  - success → `/success?gateway=sslcommerz&tran_id=…&source=buy_now`
  - fail/cancel → `/buy-now?product=<id>&sku=<the cart's one item>&qty=<qty>&payment=failed|cancelled` (product id looked up from the variant)

  Otherwise as today. The base is still `STORE_URL` (no open redirect); an
  unknown `tran_id` behaves as today.

**Success page:** clears the local cart only when `source !== 'buy_now'`
(a small pure helper `shouldClearCart(searchParams)` with unit tests).

### 2. Page builder

**Data:** table `home_sections`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `type` | `banner` \| `catalogue` \| `showcase` |
| `title` | plain text or per-locale JSON (showcase only) |
| `category_id` | showcase only; `REFERENCES categories(id) ON DELETE CASCADE` |
| `product_limit` | showcase only, 4 to 24, default 12 |
| `sort_order` | integer |
| `status` | `active` \| `hidden` |
| `created_at`, `updated_at` | |

The migration seeds the two built-in sections, `banner` (the hero from
Admin → Banners) at 0 and `catalogue` (category nav + product grid) at 100,
so the home page looks exactly as today until the admin changes something.
Built-in sections can be moved and hidden but not deleted or duplicated.

**Admin API** (`/v1/admin/home-sections`, admin only, mounted before the
`customerAuth` routers like the other admin modules):
- `GET /` list (with category name and live product count for showcase).
- `POST /` create a showcase section; `PATCH /:id`; `DELETE /:id` (409 for
  built-ins).
- `PUT /order` `{ ids: [...] }`: sets `sort_order` for all sections in one
  transaction; 400 unless the ids are exactly the existing sections.
- `POST /starter` creates the three showcase-only categories (Offers, New
  collection, Hot picks, per-locale names) and a hidden section for each.
  It skips any that already exist, so running it twice doesn't create duplicates.
  Hidden until they have products, so the shop never shows an empty row.

**Public API:** `GET /v1/storefront/home` returns active sections in order. Each
showcase section includes its products (active, ordered by
`product_categories.position`, up to `product_limit`, thumbnail images, same
product shape as listings). Sections whose category has no active products are
left out. One request for the whole page. KV-cached; purged on any change to
home sections, categories or products.

**Admin page** (`pages/admin/page-builder.tsx`, nav group "Catalogue" next to
Banners, label "Page builder"):
- A vertical list of section cards: drag handle, type icon, title, details
  (category, product count, "Hidden"), Move up / Move down buttons, Edit, Hide /
  Show, Delete (showcase only). The banner card links to Admin → Banners.
- Edit/create in a dialog: title per locale, category select (showcase-only
  categories first; any category allowed), product limit, status.
- Empty state for showcase: "Add the Offers, New collection and Hot picks
  sections" (calls `/starter`).
- Reorder saves immediately (`PUT /order`), optimistic, reverted with an error
  message if it fails. A live region announces "Moved Offers to position 2 of 5".

**Drag-and-drop library: `@dnd-kit/core` + `@dnd-kit/sortable` +
`@dnd-kit/utilities`.**
- Keyboard: `KeyboardSensor` with `sortableKeyboardCoordinates`. Focus the
  handle, Space/Enter to pick up, arrow keys to move, Space/Enter to drop,
  Escape to cancel. dnd-kit's screen-reader instructions and announcements are
  passed through i18n (all seven locales).
- Pointer and touch: `PointerSensor` with a small activation distance (so
  clicks on buttons inside a card still work) and `TouchSensor` with a short
  press delay (so the page still scrolls on phones).
- Move up / Move down buttons as well, for anyone who doesn't drag.
- Admin-only lazy chunk: it doesn't touch the home-page bundle.
- Rejected: native HTML5 drag and drop (no touch, no keyboard);
  `@hello-pangea/dnd` (heavier, list-only, unclear React 19 support);
  Atlassian pragmatic-drag-and-drop (keyboard support is left to the app).
- Versions: pin exact versions that are at least two weeks old (e.g.
  `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `@dnd-kit/utilities@3.2.2`);
  the builder confirms peer ranges with `npm view` before installing.

### 3. Showcase sections on the home page

`pages/index.tsx` renders `GET /v1/storefront/home` in order:
- `banner` → `HomeHero` (unchanged)
- `catalogue` → category nav + product grid (unchanged)
- `showcase` → `ShowcaseRow`

When a category filter or search is active (`?category=` / `?q=`), only the
catalogue section shows, as today. If the home request fails, the page falls
back to banner + catalogue (today's page).

**`ShowcaseRow`** (`components/showcase-row.tsx`):
- `<section aria-labelledby>` with an `h2` title (resolved per locale).
- A `<ul>` that scrolls horizontally: `overflow-x-auto`, `snap-x snap-mandatory`,
  `scroll-px-4`, no visible scrollbar on touch. Items are `snap-start shrink-0`,
  about 2.2 cards visible on a phone, 4 on a tablet, 5 to 6 on desktop, so it's
  clear that the row scrolls.
- Each item is the existing `ProductCard` (image 4:5, price, Add to cart). No
  `categoryHandle` is passed, so product pages opened from a row get no
  breadcrumb to the hidden category.
- Desktop: Previous/Next buttons (`aria-label` "Previous products in Offers")
  scroll by one visible width; disabled at the ends; `behavior: 'smooth'`
  unless `prefers-reduced-motion`, then instant. Phones swipe.
- Keyboard: Tab moves through the cards' links and buttons; focused items scroll
  into view (native). No auto-play, no focus traps.
- Load speed: rows reserve their height (skeleton with the same card size while
  loading); images `loading="lazy"` with fixed aspect ratio; the first section
  is not a showcase by default, so the hero stays the LCP element.
- RTL (Arabic, Hebrew): direction follows `<html dir>`; Previous/Next arrows
  flip.

### 4. Hidden (showcase-only) categories

`categories.visibility TEXT NOT NULL DEFAULT 'listed' CHECK (visibility IN
('listed','showcase'))` (schema + inline migration + SQL file, with `carts.source`
in migration 042).

**Admin:** the category editor gains "Showcase only: hidden from the shop's
category list". A showcase-only category can't have a parent or children
(400 with a clear message), so nothing listed is nested under something hidden.
Admin category lists, the product editor's category picker and the page builder
show all categories, with a "Showcase" tag.

**Everywhere a shopper could see a category, showcase-only ones are excluded on
the server** (a shared SQL condition in `lib/`, so there is one rule):

| Place | Change |
|---|---|
| `GET /v1/categories` (nav, filter chips, side list, hero count, breadcrumb name lookup, banner link picker) | `AND visibility = 'listed'` |
| `GET /v1/categories/:handle` and `/:handle/products` | 404 for showcase-only categories (so `/?category=offers` shows the "category not found" state, not a working filter) |
| `categories` inside public product responses (`/v1/products`, `/v1/products/:id`, category product lists) | showcase-only ones left out; admin requests (sk / admin session) still see them |
| `GET /sitemap.xml` | listed only. (Its query today uses `WHERE active = 1`, but the column is `status`; fixed here to `status = 'active' AND visibility = 'listed'`) |
| UCP category list and the category filter in UCP product search | listed only |
| Banner editor link picker | only listed categories offered, so a banner can't link to a hidden one |
| Product page breadcrumb | already only built from router state passed by the catalogue grid; rows pass none (see above) |

Products in a showcase category are otherwise normal: they still appear in "All
products", search and their listed categories.

### i18n

New keys for Buy now, the Buy now page, the page builder (including dnd-kit's
screen-reader text), showcase rows and the category visibility option, in all
seven locales; the parity test covers them. Starter category names are stored
as per-locale JSON.

## Spec sections this overrides

From `docs/superpowers/specs/2026-11-23-bengal-redesign-design.md`:

1. **Non-goal "No backend changes except the carousel label field (decision
   4)"**: replaced. Allowed backend changes: `carts.source`, the SSLCommerz
   return lookup, `categories.visibility` and the category filters above,
   `home_sections` with its admin and public routes, KV cache rules for
   `/v1/storefront/home`, the sitemap query fix.
2. **Non-goal "No change to checkout logic, payment flows or admin data
   behaviour"**: replaced for checkout. Buy now adds a second way into checkout;
   the SSLCommerz return target and the success page's cart clearing now depend
   on the cart's source. Cart checkout, payment verification and order creation
   are unchanged.
3. **Decision 4 "Carousel (amended)"**: superseded. No `featured_label` column, no
   label carousel, no dev placeholder slides. Featured products are showcase
   sections. "Pending owner confirmation" is resolved by this spec.
4. **Goals, storefront list**: "featured carousel" becomes "showcase rows from the
   page builder".
5. **Goals, load speed**: "header, hero and carousel reserve their space" becomes
   "header, hero and showcase rows reserve their space".
6. **Goals, accessibility**: "carousel works by keyboard" becomes "showcase rows
   and the page builder's reordering work by keyboard".
7. **Design, page table, Home row**: "featured carousel (dev placeholder / hidden
   in prod)" becomes "sections in the page-builder order: banner, catalogue,
   showcase rows".
8. **i18n**: "carousel" keys are replaced by the keys listed above.

From `claude/bengal-redesign-decisions.md`:

9. **§1 "Carousel ships now"**: superseded by decision 3 above, including "It is
   the only backend change in this redesign".

Unchanged: the anti-goal against fake functionality (empty showcase sections
are not shown; no placeholder rows).

## Verification

- Backend (`apps/merchant`, `tsc` + vitest on the real schema): cart source;
  SSLCommerz return targets for cart and Buy now (success, fail, cancel,
  unknown tran_id); home-sections CRUD, built-in protection, ordering,
  idempotent starter; showcase product order/limit/omission when empty;
  showcase-only categories absent from every public route above and present for
  admins; parent/child rule.
- Client unit: `shouldClearCart`; admin nav covers the new route; i18n parity.
- E2E (Playwright, light/dark, 390/1440, axe):
  - Cart has item A → Buy now B → the Buy now page shows only B; the server cart
    holds only B; the local cart still holds only A, after cancel and after
    success (Stripe test mode; SSLCommerz sandbox if keys are present, otherwise
    the return redirects are covered by backend tests).
  - Cart checkout end to end unchanged (run before and after the split).
  - Page builder: reorder by mouse, by keyboard (Space, arrows, Space) and by the
    Move buttons; the home page follows the new order.
  - Showcase row: scrolls by swipe and by Previous/Next; RTL; reduced motion.
  - `/?category=<showcase handle>` shows "not found"; the category list and
    filter don't include it.
- Lighthouse mobile on the home page with three showcase rows: LCP < 2.5 s,
  CLS < 0.1; home bundle size compared with before.

## Left to the builder

- Exact card widths per breakpoint, and skeleton styling.
- Wording of messages, within the existing tone.
- Whether `ShowcaseRow` and the catalogue grid share a card-loading helper.
