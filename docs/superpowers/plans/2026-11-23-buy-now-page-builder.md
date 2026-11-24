# Buy now, Page Builder and Showcase Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Buy now checkout that never touches the cart, a drag-and-drop page builder for the home page, and category-based showcase rows that replace the planned label carousel.

**Architecture:** Backend adds `carts.source`, `categories.visibility` and a `home_sections` table (migration 042), admin and public routes for sections, and one shared "listed categories only" rule applied to every public category path. The client splits the checkout steps out of `cart.tsx` into a reusable `CheckoutFlow`, adds a `/buy-now` page, an admin page builder using dnd-kit, and a `ShowcaseRow` horizontal scroller on the home page.

**Tech Stack:** Cloudflare Worker + Hono + `@hono/zod-openapi`, MerchantDO SQLite, React 19, HeroUI v3, react-query, i18next, `@dnd-kit/*`, vitest, Playwright + axe.

**Spec:** `docs/superpowers/specs/2026-11-23-buy-now-page-builder-design.md`

## Global Constraints

- npm only (`npm@11`), TypeScript strict, no `any` without a comment saying why.
- HeroUI buttons use `onPress`; colours via `bx-*` utilities or HeroUI tokens, never raw colours or `[var(--bx-*)]`.
- Schema changes need three edits together: `SCHEMA` in `do.ts`, the inline migration array in `ensureInitialized()`, and `migrations/042-buy-now-page-builder.sql`. Additive only.
- New admin routers are mounted in `src/index.ts` next to `/v1/admin/banners`, before the `customerAuthMiddleware` routers (see the comment there).
- Every new string goes into all seven locale files (`en-US`, `fr-FR`, `es-ES`, `zh-CN`, `ar-SA`, `he-IL`, `bn-BD`) in the same task; `src/__tests__/i18n.test.ts` must stay green after every task.
- dnd-kit versions pinned exactly: `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `@dnd-kit/utilities@3.2.2` (confirm peer ranges with `npm view` first).
- Cart checkout's markup, text and step order stay identical.
- Load speed: home LCP < 2.5 s, CLS < 0.1 on the production build (mobile profile).
- Commit steps are checkpoints: do not run `git commit` until the owner has said to commit.

## Review Focus

1. **Stock changes between the product page and Buy now** (variant goes out of stock, or qty > stock): the Buy now page shows the server's error at the "Checkout" step and the local cart is still untouched. Test: Task 6, `buy-now keeps the cart when adding the item fails`.
2. **A category used by a section is deleted, or switched to showcase-only while it has children**: the section disappears (cascade) and the home page still renders; switching with children returns 400. Tests: Task 2 `rejects showcase-only with children`, Task 3 `deleting the category removes its section`.
3. **SSLCommerz returns with a missing or unknown `tran_id`**: same redirect as today (`/cart?payment=…` or `/success?gateway=sslcommerz`). Test: Task 4 `unknown tran_id keeps today's targets`.
4. **Two admins reorder at once** (`PUT /order` with a stale id list): 400, the page reloads the list and says so. Tests: Task 3 `order rejects a stale id list`, Task 9 `reloads after a rejected reorder`.
5. **A shopper opens `/?category=<showcase handle>`, or a product page opened from a row**: "category not found" state, no crash, no breadcrumb to the hidden category. Tests: Task 2 `handle routes 404 for showcase-only`, Task 8 e2e `hidden category link shows not found`.

---

### Task 1: Migration 042 (cart source, category visibility, home sections)

**Files:**
- Modify: `apps/merchant/src/do.ts` (SCHEMA: `carts`, `categories`, new `home_sections`; inline migrations after `041_products_add_images`)
- Create: `apps/merchant/migrations/042-buy-now-page-builder.sql`
- Test: `apps/merchant/tests/buy-now-page-builder.test.ts` (new; the later backend tasks add to it)

**Interfaces:**
- Produces: columns `carts.source` (`'cart' | 'buy_now'`, default `'cart'`), `categories.visibility` (`'listed' | 'showcase'`, default `'listed'`); table `home_sections(id, type, title, category_id, product_limit, sort_order, status, created_at, updated_at)` with `type IN ('banner','catalogue','showcase')`, `status IN ('active','hidden')`, `product_limit` default 12, `category_id REFERENCES categories(id) ON DELETE CASCADE`, index `(status, sort_order)`. Seed rows: ids `'builtin-banner'` (type `banner`, sort 0) and `'builtin-catalogue'` (type `catalogue`, sort 100), both `active`, inserted with `INSERT OR IGNORE`.
- Inline migration names: `042_carts_add_source`, `042_categories_add_visibility`, `042_home_sections`, `042_home_sections_idx`, `042_home_sections_seed`.

- [ ] **Step 1: Write the failing test** `migration 042 adds source, visibility and seeded sections`: after `createMerchantDb(env).ready()`, a new cart row reads `source === 'cart'`; a new category reads `visibility === 'listed'`; `SELECT id,type,sort_order FROM home_sections ORDER BY sort_order` equals `[{id:'builtin-banner',type:'banner',sort_order:0},{id:'builtin-catalogue',type:'catalogue',sort_order:100}]`; running `ensureInitialized` twice leaves exactly 2 rows.
- [ ] **Step 2: Run** `cd apps/merchant && npx vitest run tests/buy-now-page-builder.test.ts`. Expected: FAIL (no such column `source`).
- [ ] **Step 3: Add the three schema edits and the SQL file** with the columns, checks and seed above.
- [ ] **Step 4: Run the test again.** Expected: PASS. Also `npx tsc --noEmit -p .` is clean.
- [ ] **Step 5: Commit checkpoint** `feat(merchant): migration 042 for buy now, category visibility, home sections`.

### Task 2: Showcase-only categories are invisible to shoppers

**Files:**
- Create: `apps/merchant/src/lib/category-visibility.ts`
- Modify: `apps/merchant/src/routes/categories.ts` (list, `/:handle`, `/:handle/products`, create/patch bodies), `apps/merchant/src/routes/catalog.ts` (the four `SELECT c.* FROM categories c` joins at ~390, 476, 538, 753), `apps/merchant/src/routes/sitemap.ts`, `apps/merchant/src/routes/ucp.ts` (~1172 filter, ~1263 list), `apps/merchant/src/schemas.ts` (category response + create/update bodies)
- Test: `apps/merchant/tests/buy-now-page-builder.test.ts`

**Interfaces:**
- Produces:
  - `LISTED_CATEGORY_SQL = "visibility = 'listed'"` (string, for the `c.` alias use `listedCategorySql(alias: string): string`)
  - `isAdminRequest(c: Context<HonoEnv>): boolean` (true for `sk_` keys and admin sessions, matching how `authMiddleware` sets the role)
  - `CategoryVisibility = z.enum(['listed','showcase'])`
  - Category response field `visibility`; create/patch bodies accept `visibility` optional.
- Consumes: Task 1 columns.

- [ ] **Step 1: Write the failing tests:**
  - `public category list leaves out showcase-only`: create `shoes` (listed) and `offers` (showcase); `GET /v1/categories` handles equal `['shoes']`; with the SK key the list contains both.
  - `handle routes 404 for showcase-only`: `GET /v1/categories/offers` and `/v1/categories/offers/products` → 404 without auth; 200 with SK.
  - `product responses hide showcase categories from shoppers`: a product in both; public `GET /v1/products/:id` `.categories` handles `['shoes']`; SK sees both. Same for `GET /v1/products` items.
  - `sitemap lists only listed active categories`: response contains `/shoes`, not `/offers` (and no longer throws on the old `active = 1` column).
  - `UCP category list leaves out showcase-only`.
  - `rejects showcase-only with children`: PATCH a parent with a child to `visibility:'showcase'` → 400; POST a showcase category with `parent_id` → 400.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, then append `AND visibility = 'listed'` (or `listedCategorySql('c')`) to each public query unless `isAdminRequest(c)`. Handle routes throw `ApiError.notFound('Category not found')`. Sitemap query becomes `WHERE status = 'active' AND visibility = 'listed'`.
- [ ] **Step 4: Run the tests and the whole suite** `npx vitest run`. Expected: new tests PASS; only the three known live-server suites fail (`advanced-routes`, `regions.integration`, `variant-pricing`).
- [ ] **Step 5: Commit checkpoint** `feat(merchant): showcase-only categories hidden from shoppers`.

### Task 3: Home sections API

**Files:**
- Create: `apps/merchant/src/routes/home-sections.ts`
- Modify: `apps/merchant/src/index.ts` (mount `publicHome` at `/v1/storefront` next to `publicStorefrontSettings`; `adminHomeSections` at `/v1/admin/home-sections` next to `/v1/admin/banners`; add `/v1/storefront/home` to `kvCacheMiddleware`; purge it in `kvInvalidateMiddleware` for `/v1/products*`, `/v1/categories*`, `/v1/admin/home-sections*`), `apps/merchant/src/middleware/kv-cache.ts` (the extra purge prefix)
- Test: `apps/merchant/tests/buy-now-page-builder.test.ts`

**Interfaces:**
- Consumes: Task 1 table, Task 2 `CategoryVisibility`.
- Produces (JSON shapes the client tasks use):
  - `HomeSection = { id: string; type: 'banner'|'catalogue'|'showcase'; title: string|null; category_id: string|null; category_name: string|null; category_visibility: 'listed'|'showcase'|null; product_limit: number; sort_order: number; status: 'active'|'hidden'; product_count: number; builtin: boolean }`
  - Admin: `GET /` → `{ items: HomeSection[] }`; `POST /` body `{ title: string; category_id: string; product_limit?: 4..24; status?: 'active'|'hidden' }` → 201 `HomeSection` (type `showcase` only); `PATCH /:id` same fields optional (built-ins accept only `status`); `DELETE /:id` → 409 for built-ins; `PUT /order` `{ ids: string[] }` → `{ items }`; `POST /starter` → `{ items, created: number }`.
  - Public: `GET /v1/storefront/home` → `{ sections: PublicSection[] }`, `PublicSection = { id; type; title: string|null; products?: StoreProduct[] }` (products only for showcase; same product shape and `thumbnail=true` image mode as `GET /v1/products`).
  - Starter categories: handles `offers`, `new-collection`, `hot-picks`, `visibility:'showcase'`, names as per-locale JSON for all seven locales; sections created `hidden`, `product_limit` 12.

- [ ] **Step 1: Write the failing tests:**
  - `lists built-ins first and creates a showcase section`.
  - `built-ins cannot be deleted or retargeted`: DELETE `builtin-banner` → 409; PATCH `builtin-catalogue` with `category_id` → 400; PATCH `{status:'hidden'}` → 200.
  - `order sets sort_order for every section`: PUT the reversed ids → GET returns that order.
  - `order rejects a stale id list`: missing one id, or an unknown id → 400, order unchanged.
  - `starter is idempotent`: two calls → three sections and three categories total; second call `created === 0`.
  - `public home returns active sections in order with ordered, limited products`: category with 5 products at positions 3,1,2,5,4 and `product_limit` 4 → product ids in position order, length 4; hidden sections and showcase sections with no active products are absent.
  - `deleting the category removes its section`.
  - `admin routes need an admin key` (none → 401, pk → 403).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the routers.** `PUT /order` writes all rows in one `transactionSync`; product loading reuses the catalog's product mapping (export it from `catalog.ts` if needed rather than duplicating it).
- [ ] **Step 4: Run the tests**, plus a manual check against `wrangler dev`: `curl /v1/storefront/home` twice. The second response comes from KV (`x-cache: HIT` or the existing marker), and changes after `PATCH` of a section.
- [ ] **Step 5: Commit checkpoint** `feat(merchant): home sections admin and public API`.

### Task 4: Cart source and SSLCommerz return targets

**Files:**
- Modify: `apps/merchant/src/schemas.ts` (`CreateCartBody.source`, cart response `source`), `apps/merchant/src/routes/checkout.ts` (createCart insert), `apps/merchant/src/routes/sslcommerz-ipn.ts` (`sslcommerzReturnLocation`, the `/return/:result` handler)
- Test: `apps/merchant/tests/sslcommerz.test.ts`, `apps/merchant/tests/buy-now-page-builder.test.ts`

**Interfaces:**
- Produces: `CreateCartBody.source?: 'cart'|'buy_now'`; `sslcommerzReturnLocation(storeUrl: string, result: string, tranId: string | null, buyNow?: { productId: string; sku: string; qty: number } | null): string`.
  - With `buyNow`, success → `${base}/success?gateway=sslcommerz&tran_id=<id>&source=buy_now`; fail/cancel → `${base}/buy-now?product=<id>&sku=<sku>&qty=<n>&payment=failed|cancelled`.
  - Without it: unchanged (the two existing assertions at `sslcommerz.test.ts:291-292` stay as they are).
- The handler looks the cart up by `sslcommerz_tran_id`; for `source='buy_now'` it reads the one `cart_items` row and the variant's `product_id`. All values are URL-encoded.

- [ ] **Step 1: Write the failing tests:**
  - `creates a buy_now cart and returns its source`.
  - `buy-now return targets` (pure function: the success, fail and cancel strings above).
  - `return handler sends buy-now payments back to the buy-now page`: seeded cart with `source='buy_now'` and tran id `TXN-b` → `/return/fail?tran_id=TXN-b` 303 Location `…/buy-now?product=…&sku=…&qty=2&payment=failed`.
  - `unknown tran_id keeps today's targets`: `TXN-none`, and no `tran_id` at all → today's `/cart?payment=failed` and `/success?gateway=sslcommerz`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/sslcommerz.test.ts tests/buy-now-page-builder.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit checkpoint** `feat(merchant): cart source and buy-now SSLCommerz returns`.

### Task 5: Split the checkout steps out of cart.tsx (no behaviour change)

**Files:**
- Create: `apps/client/src/components/checkout/checkout-flow.tsx`
- Modify: `apps/client/src/pages/cart.tsx` (remove the step state and handlers at ~lines 46-230 and the step markup; render `CheckoutFlow`), `apps/client/src/lib/store-api.ts` (`createCart(email, locale?, source?)`)
- Create: `e2e/tests/public/cart-checkout.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CheckoutSource = "cart" | "buy_now";
  export interface CheckoutFlowProps {
    items: { sku: string; qty: number }[];
    source: CheckoutSource;
    /** Stripe cancel URL. */
    cancelUrl: string;
    /** Leaves the flow (cart: back to the item list). */
    onBack: () => void;
    /** Lets the parent hide its own controls while the flow runs. */
    onStepChange?: (step: CheckoutStep) => void;
  }
  export function CheckoutFlow(props: CheckoutFlowProps): JSX.Element;
  ```
  `CheckoutStep` moves to this file and is exported. The Stripe success URL is `${STORE_URL}/success?session_id={CHECKOUT_SESSION_ID}` for `cart` and the same plus `&source=buy_now` for `buy_now`.
- Consumes: Task 4 (`source` on create).

- [ ] **Step 1: Write the regression e2e first, against the current code:** `cart checkout reaches the payment step unchanged`. Add a product, open `/cart`, enter email, continue as guest, fill the address, pick a rate, see the payment method radio group. Intercept `**/v1/carts` POST and `**/items` POST to record bodies. Assert: items equal the cart's items; the create body has no `source` or `source:'cart'`; and an `aria-snapshot` of the checkout region per step. Save the snapshots.
- [ ] **Step 2: Run it on today's code** `cd e2e && npx playwright test tests/public/cart-checkout.spec.ts --project=public-chromium`. Expected: PASS (records the baseline).
- [ ] **Step 3: Move the steps into `CheckoutFlow`** without changing markup or text; `cart.tsx` passes `items` from `useCart`, `source="cart"`, `cancelUrl={window.location.href}`.
- [ ] **Step 4: Run** the e2e again (same snapshots must match), plus `npm run type-check`, `npm test` and `npx eslint src/pages/cart.tsx src/components/checkout`. Expected: all PASS, no new errors.
- [ ] **Step 5: Commit checkpoint** `refactor(client): checkout steps as a reusable CheckoutFlow`.

### Task 6: Buy now button, Buy now page, success page

**Files:**
- Create: `apps/client/src/pages/buy-now.tsx`, `apps/client/src/lib/checkout-source.ts`, `apps/client/src/__tests__/checkout-source.test.ts`
- Modify: `apps/client/src/components/product-card-full.tsx` (button), `apps/client/src/app.tsx` (lazy route `/buy-now` inside `ShellRoute`), `apps/client/src/pages/success.tsx`, locale files
- Create: `e2e/tests/public/buy-now.spec.ts`

**Interfaces:**
- Produces: `shouldClearCart(params: URLSearchParams, storage?: Storage): boolean` (false when `source === 'buy_now'`, or when sessionStorage `checkout_source` is `'buy_now'`: a backstop if the flag is lost, added after the Task 4 review); `markCheckoutSource(source: CheckoutSource, storage?: Storage): void` (CheckoutFlow calls it just before redirecting to Stripe or SSLCommerz; storage errors are ignored); the success page removes the key after reading it; `buyNowHref(productId: string, sku: string, qty = 1): string` → `/buy-now?product=…&sku=…&qty=…`; `parseBuyNowParams(params: URLSearchParams): { productId: string; sku: string; qty: number } | null` (`qty` clamped 1-99, defaults to 1; null if product or sku missing).
- Consumes: `CheckoutFlow` (Task 5), `getProduct` (store-api), `paymentReturnMessageKey`.
- Copy (en-US; translate the others): `product-buy-now` "Buy now", `product-preorder-now` "Pre-order now", `buy-now-title` "Buy now", `buy-now-not-found` "This product isn't available any more.", `buy-now-back` "Back to the product", `buy-now-cart-note` "Your cart isn't changed.", `buy-now-quantity` "Quantity".

- [ ] **Step 1: Write the failing unit tests:** `shouldClearCart` (`?session_id=x` → true; `?gateway=sslcommerz&tran_id=t` → true; `&source=buy_now` → false); `parseBuyNowParams` (qty `0` → 1, `500` → 99, `abc` → 1, missing sku → null); `buyNowHref` encodes values.
- [ ] **Step 2: Write the failing e2e** `buy-now.spec.ts`:
  - `buy now checks out one product and leaves the cart alone`: add product A to the cart, open product B, press Buy now. The URL is `/buy-now?product=…&sku=…&qty=1`, only B is listed, and the cart badge still shows 1. Go through the email, guest, address and rate steps; the intercepted `POST /v1/carts` body has `source:'buy_now'` and the items POST has only B's sku. Intercept the Stripe redirect: `success_url` contains `source=buy_now`. Then visit `/success?session_id=x&source=buy_now`: `localStorage.merchant_cart` still holds only A. Visit `/success?session_id=x`: the cart is cleared.
  - `buy-now keeps the cart when adding the item fails`: route `**/items` to 400 `{"error":{"message":"Insufficient stock"}}`. The message shows and the cart is unchanged.
  - `out-of-stock variant disables Buy now`: route the product response with `availability:'out_of_stock'`; the button is disabled.
  - `payment failed message on return`: `/buy-now?product=…&sku=…&qty=2&payment=failed` shows the failed message and qty 2.
  - axe: no serious or critical issues on `/buy-now` at 390 and 1440, light and dark.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** the helpers, the page (one-line summary + quantity stepper + `CheckoutFlow` with `source="buy_now"` and `cancelUrl=buyNowHref(...)`), the button (`variant="secondary"`, same disabled rule as Add to cart, navigates with `useNavigate`, never calls `useCart`), and `success.tsx` calling `clear()` only if `shouldClearCart(searchParams)`.
- [ ] **Step 5: Run** the unit tests, the e2e, `npm run type-check`, lint on touched files, and the Task 5 regression e2e. Expected: all PASS.
- [ ] **Step 6: Commit checkpoint** `feat(client): buy now checkout that leaves the cart alone`.

### Task 7: Admin: showcase-only option on categories, banner picker

**Files:**
- Modify: `apps/client/src/components/category-admin.tsx` (checkbox + "Showcase" tag in lists), `apps/client/src/hooks/use-categories.ts` (`Category.visibility?: 'listed' | 'showcase'`), `apps/client/src/pages/admin/banners.tsx` (LinkPicker offers `visibility !== 'showcase'` only, as a guard; the public list already excludes them), `apps/client/src/pages/admin/products.tsx` (category picker shows the tag), locale files
- Test: `e2e/tests/admin/admin-crud.spec.ts` (new test)

**Interfaces:**
- Consumes: Task 2 (`visibility` on category create/patch/response; 400 message for parent/children).
- Copy: `admin-category-showcase-only` "Showcase only", `admin-category-showcase-help` "Hidden from the shop's category list and filters. Use it for page-builder sections like Offers.", `admin-category-showcase-tag` "Showcase", `admin-category-showcase-nesting` "A showcase-only category can't have a parent or subcategories."

- [ ] **Step 1: Write the failing e2e** `category marked showcase-only disappears from the shop`: as admin, create a category, tick Showcase only, save, and the list shows the "Showcase" tag. As a guest on `/products`, the category list and filter chips don't contain it, and `/?category=<handle>` shows the not-found state. Delete it afterwards.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** The checkbox is a labelled native checkbox with `aria-describedby` on the help text; server 400s show inline.
- [ ] **Step 4: Run** the e2e (`--project=auth-admin`), type-check, unit tests. Expected: PASS.
- [ ] **Step 5: Commit checkpoint** `feat(client): showcase-only categories in admin`.

### Task 8: Home page renders sections; ShowcaseRow

**Files:**
- Create: `apps/client/src/components/showcase-row.tsx`, `apps/client/src/lib/home-sections.ts`
- Modify: `apps/client/src/pages/index.tsx`, locale files
- Create: `e2e/tests/public/showcase.spec.ts`

**Interfaces:**
- Produces: `useHomeSections(): UseQueryResult<PublicSection[]>` (query key `['home-sections']`, `staleTime` 60 s, falls back to `[{type:'banner'},{type:'catalogue'}]` on error); `ShowcaseRow({ section }: { section: PublicSection & { type: 'showcase' } })`.
- Consumes: Task 3 `GET /v1/storefront/home`, `ProductCard` (no `categoryHandle` prop), `HomeHero`, `resolveTitle`.
- Values: item widths `w-[44%] sm:w-[30%] md:w-[23%] lg:w-[18%]` (about 2.2 / 3.3 / 4.3 / 5.5 cards visible); `snap-x snap-mandatory`, `scroll-px-4`, items `snap-start shrink-0`; Previous/Next buttons only at `md:` and up, scrolling by `clientWidth * 0.9`; `behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'`; RTL flips arrow icons (`rtl:rotate-180`) and the sign of `scrollBy`. Skeleton: same item widths, `aspect-[4/5]` image block, shown while loading.
- Copy: `showcase-previous` "Previous products in {{title}}", `showcase-next` "Next products in {{title}}".
- `index.tsx`: with `?category` or `?q`, render only the catalogue section (as today); otherwise map sections in order (`banner` → `HomeHero`, `catalogue` → existing nav + grid, `showcase` → `ShowcaseRow`).

- [ ] **Step 1: Write the failing e2e tests:**
  - `home follows section order`: route `/v1/storefront/home` to banner, showcase "Offers" (6 products), catalogue → DOM order hero, "Offers" heading, catalogue heading.
  - `row scrolls by buttons and stops at the ends`: at 1440, Previous is disabled at the start; Next scrolls (`scrollLeft` increases); at the end Next is disabled.
  - `row works by keyboard`: Tab into the row, and the focused card's link is visible within the row's box.
  - `RTL row`: `ar-SA` locale, Next scrolls toward the start and the icon is flipped.
  - `reduced motion scrolls instantly`.
  - `hidden category link shows not found`: `/?category=offers` (route `/v1/categories/offers/products` to 404) shows the not-found state and no console error.
  - `falls back to today's page when the home request fails`: route to 500 → hero + catalogue.
  - axe clean at 390 and 1440, light and dark; `ov=0` (no horizontal page overflow).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `home-sections.ts`, `ShowcaseRow`, and the `index.tsx` mapping.
- [ ] **Step 4: Run** the e2e, unit tests and type-check; then `npm run build` and Lighthouse mobile on `/` with three active showcase rows: LCP < 2.5 s, CLS < 0.1; record the home chunk size against `main`.
- [ ] **Step 5: Commit checkpoint** `feat(client): home sections and showcase rows`.

### Task 9: Admin page builder with dnd-kit

**Files:**
- Create: `apps/client/src/pages/admin/page-builder.tsx`, `apps/client/src/components/admin/section-card.tsx`, `apps/client/src/components/admin/section-editor.tsx`
- Modify: `apps/client/package.json` (dnd-kit pins), `apps/client/src/app.tsx` (lazy child route `page-builder`), `apps/client/src/config/admin-nav.ts` (Catalogue group, after Banners, icon `LayoutList`, label `admin-page-builder-title`), `apps/client/src/__tests__/admin-nav.test.ts` (24 → 25 routes), locale files
- Create: `e2e/tests/admin/page-builder.spec.ts`

**Interfaces:**
- Consumes: Task 3 admin API and `HomeSection`; Task 7's "Showcase" tag; `useSecuredApi`; `LocalizedTitleInput`.
- Produces: none used elsewhere. Invalidates react-query `['home-sections']` after every change.
- dnd-kit setup: `DndContext` with `sensors = [PointerSensor({ activationConstraint: { distance: 6 } }), TouchSensor({ activationConstraint: { delay: 200, tolerance: 8 } }), KeyboardSensor({ coordinateGetter: sortableKeyboardCoordinates })]`, `closestCenter`; `SortableContext` with `verticalListSortingStrategy`. The drag handle is a `<button>` with `aria-label` "Reorder {{title}}" and dnd-kit's `attributes`/`listeners`. `accessibility.screenReaderInstructions` and `announcements` (onDragStart/Over/End/Cancel) come from i18n keys `admin-page-builder-dnd-*`.
- Copy (en-US; translate the others): `admin-page-builder-title` "Page builder", `admin-page-builder-subtitle` "The sections of the home page, top to bottom. Drag them, or use the move buttons, to change the order. Changes go live straight away.", `admin-page-builder-add` "Add a section", `admin-page-builder-starter` "Add the Offers, New collection and Hot picks sections", `admin-page-builder-banner` "Banner", `admin-page-builder-catalogue` "Product catalogue", `admin-page-builder-edit-banners` "Edit banners", `admin-page-builder-hidden` "Hidden", `admin-page-builder-show` "Show", `admin-page-builder-hide` "Hide", `admin-page-builder-move-up` "Move {{title}} up", `admin-page-builder-move-down` "Move {{title}} down", `admin-page-builder-moved` "Moved {{title}} to position {{n}} of {{total}}.", `admin-page-builder-reorder-failed` "Someone else changed the sections. The list has been reloaded.", `admin-page-builder-category` "Category", `admin-page-builder-limit` "Products shown (4 to 24)", `admin-page-builder-products` "{{n}} products", `admin-page-builder-empty-category` "No products in this category yet, so the section isn't shown.", `admin-page-builder-delete-confirm` "Delete the section “{{title}}”? Its category and products are not deleted.", and the dnd-kit instruction/announcement strings.

- [ ] **Step 1: Confirm and install the libraries:** `npm view @dnd-kit/sortable@10.0.0 peerDependencies` shows `@dnd-kit/core: ^6.3.0` and React 19 within range; then `npm install -w apps/client @dnd-kit/core@6.3.1 @dnd-kit/sortable@10.0.0 @dnd-kit/utilities@3.2.2 --save-exact`.
- [ ] **Step 2: Write the failing tests:**
  - Unit: `admin-nav.test.ts` expects 25 routes including `/admin/page-builder`.
  - E2E:
    - `reorders by mouse`: drag "Product catalogue" above "Banner"; the `PUT /order` body has the catalogue id first; after reload the order persists; the home page shows the catalogue first.
    - `reorders by keyboard`: focus the "Reorder Offers" handle, press Space, ArrowUp, Space; the live region says "Moved Offers to position 1 of 3".
    - `reorders by buttons`: "Move Offers down".
    - `starter creates three hidden sections`.
    - `create, edit, hide and delete a showcase section`: built-in cards have no Delete button.
    - `reloads after a rejected reorder`: route `PUT /order` to 400; the message shows and the list is the server's.
    - axe clean at 390 and 1440, light and dark; the dialog is labelled.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** the page, the card (handle, title, details, Move up/down, Edit, Hide/Show, Delete for showcase only, "Edit banners" link on the banner card), and the editor dialog (title via `LocalizedTitleInput` with a locale select, category select listing showcase-only categories first, limit 4-24, status).
- [ ] **Step 5: Run** the e2e, unit tests, type-check, lint on new files, and `npm run build` (dnd-kit must land in the admin chunk only: `grep -l dnd-kit dist/assets/*.js` lists no file loaded by `/`).
- [ ] **Step 6: Commit checkpoint** `feat(client): admin page builder with keyboard-accessible drag and drop`.

### Task 10: Spec bookkeeping and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-11-23-bengal-redesign-design.md` (an "Amended by" line in the header pointing to the new spec, and a one-line note at decision 4: "Superseded by 2026-11-23-buy-now-page-builder-design.md"), `claude/bengal-redesign-decisions.md` (same note on §1), `openapi.json` (repo root) via `npm run gen:openapi` in `apps/merchant` (stop any running `wrangler dev` on 8787 first)

- [ ] **Step 1: Add the notes** above, without rewriting the old text.
- [ ] **Step 2: Run everything:** in `apps/merchant` run `npx tsc --noEmit -p .` and `npx vitest run` (only the three known live-server suites fail). In `apps/client` run `npm run type-check`, `npm test`, `npm run lint` (no new errors; warning count reported) and `npm run build`. Then the e2e projects `public-chromium` and `auth-admin`.
- [ ] **Step 3: Screenshots** at 390 and 1440, light and dark, for `/`, `/product/<id>`, `/buy-now?…`, `/cart` and `/admin/page-builder`; check by eye; axe report attached.
- [ ] **Step 4: Report** to the owner: what shipped, test results, Lighthouse numbers, bundle change, and the translations needing native review.
- [ ] **Step 5: Commit checkpoint** `docs: mark carousel decision superseded by showcase sections`.
