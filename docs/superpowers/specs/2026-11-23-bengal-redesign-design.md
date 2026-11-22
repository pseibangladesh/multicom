# Bengal Exchange redesign — design

**Date:** 2026-11-23 · **Source design:** `bengal-exchange-storefront-v2.html` (storefront mock, light + dark)
· **Amended by:** `bengal-redesign-decisions.md` (carousel, load speed, Bangla fonts, clarifications). Where they differ, the amendments below win.

## Intent

Make every page of `apps/client` (storefront, account, admin) look and behave like one Bengal Exchange product, following the v2 storefront mock: warm paper/ink palette with indigo primary and rust accent, serif display type with a sans body, thin rules instead of heavy cards, small radius, light and dark modes, phone-first layouts.

## Goals

- One visual language across all pages, in light and dark, at phone (≈390 px) and desktop (≈1440 px).
- Storefront matches the mock: sticky blurred header with centre nav and search, right-hand side menu (profile, log in/out, language, light/dark, about, blog, contact), hero, featured carousel, product grid with filter chips, marketplaces strip, footer.
- Admin keeps a work-focused layout (approach B below) with the same colours, type and buttons.
- Nothing that does nothing: hidden placeholders in production.
- **Load speed** (checked on the production build with a mid-range phone profile):
  - Largest Contentful Paint under 2.5 s on the home page.
  - Cumulative Layout Shift under 0.1: header, hero and carousel reserve their space before content loads.
  - Product images lazy-load and have fixed aspect ratios.
  - No blocking web fonts (system serif and sans stacks).
  - No shadows, gradients or heavy assets used only for decoration.
  - Home-page bundle size is checked on each build; any increase is reviewed.
- **Accessibility:** visible focus; the side menu and carousel work by keyboard; reduced-motion support; contrast checked in both modes (axe in the Playwright run).

## Non-goals

- No backend changes except the carousel label field (decision 4).
- No new pages for Careers, Press, FAQ, legal pages etc.
- No change to checkout logic, payment flows or admin data behaviour.

## Anti-goals (a failure even if it "works")

- A page left in the old look, or unreadable in dark mode.
- Fake functionality in production (a newsletter form that does nothing, demo carousel slides, links to missing pages).
- Breaking existing deployments that set the old theme slugs.

## Constraints

- React 19 + HeroUI v3 + Tailwind 4 (keep); HeroUI buttons use `onPress`; TypeScript strict.
- HeroUI v3 is themed through CSS variables per `data-theme`; dark mode is the `.dark` class on `<html>` (`hooks/use-theme.ts`, localStorage key `theme`).
- Theme selection today: `BENGAL_EXCHANGE_THEME` (Vite define, default `heroui_standard`), per-user `PATCH /v1/me/preferences`, guest localStorage, slugs `classic` / `luxury` / `luxury-dark`, table `store_themes`.
- i18n via `src/locales/base/*.json` with a key-parity unit test across locales.
- No new web fonts are required: the mock uses system serif/sans stacks.

## Approaches considered (admin)

| | Approach | Trade-off |
|---|---|---|
| A | Admin uses the storefront header + side menu | Fully identical, but ~20 admin pages in a slide-out menu is slow for daily work |
| **B (chosen)** | Same tokens, type and buttons; its own admin shell: left sidebar with grouped sections + slim top bar | Reads as the same brand, built for working |
| C | Admin only recoloured, layout unchanged | Fastest, keeps the clumsy dropdown navigation |

The owner chose **B**.

## Decisions (owner)

1. **Admin:** approach B.
2. **Languages:** add Bangla (`bn-BD`) as a seventh locale; the side menu's language list keeps all seven.
3. **Theme:** only the **Bengal** theme, with light and dark modes. Old slugs `classic`, `luxury`, `luxury-dark`, `default`, `heroui_standard` map to `bengal`, so stored user preferences, guest localStorage values and `store_themes` rows keep working. *Finding:* `vite.config.ts` defines `BENGAL_EXCHANGE_THEME` (renamed from `FUFUNI_THEME` in the rebrand, commit `ca61871`), but no client code reads either value, before or after the rename. So nothing breaks at runtime; the define is kept and also accepts `FUFUNI_THEME` as a fallback, and both resolve to `bengal`.
4. **Carousel (amended):** ships in production. Products get one optional label field, `offer` | `new_collection` | `hot_pick`, set per product in the admin; the carousel shows labelled products. This is the only backend change: a nullable `products.featured_label` column (schema constant + inline migration + numbered SQL file), accepted by the admin product create/update routes and returned by the public product list. The dev-only placeholder slides stay as fixtures and never show in production. **Pending owner confirmation:** if the owner prefers to wait for the backend, the section is hidden in production until the field exists. The carousel is hidden whenever no product has a label.
5. **Newsletter:** hidden until it has a backend.
6. **Footer:** link only to pages that exist (About, Blog, Contact via `#contact`, Cookie policy if it exists); hide the rest.
7. **OpenAPI:** move the hard-coded "Télécharger OpenAPI" label into the locale files.
8. **Order of work:** dark-mode fixes from the audit → storefront + header first, verified page by page in light/dark on phone/desktop → account pages → admin.

## Design

### Tokens (`src/styles/themes/bengal.css`)

Copy the mock's tokens and map them onto HeroUI's variables under `[data-theme="bengal"]` and `.dark[data-theme="bengal"]`:

| Mock token | Light | Dark | HeroUI variable(s) |
|---|---|---|---|
| paper | #F7F5F0 | #0D1221 | `--background` |
| surface / surface-raised | #FCFBF8 / #FFFFFF | #151C30 / #1B2440 | `--surface`, `--overlay`, `--surface-secondary` |
| ink / ink-soft | #15203A / #2E3A55 | #EDEFF6 / #C4CADB | `--foreground`, `*-foreground` |
| stone | #6B675D | #9AA1B6 | `--muted` |
| line | #E2DED4 | #2A3352 | `--border`, `--separator` |
| primary / on-primary | #2A3F7E / #FCFBF8 | #9DB0F2 / #0D1221 | `--accent`, `--accent-foreground`, `--focus` |
| indigo-tint | #E6E9F2 | #1C2543 | `--default`, soft fills |
| accent / accent-soft | #9E3B24 / #F3E3DC | #EB8B73 / #3A2421 | brand accent utilities (badges, saved state), `--danger` stays red |
| radius | 4px | | `--radius`, `--field-radius` |

Fonts: `--font-display` (serif stack) for headings via a `font-display` utility; `--font-sans` for body. Bangla fallbacks are added to the sans stack: `"Noto Sans Bengali", "Kohinoor Bangla", "Nirmala UI"`, then the system sans. When `lang="bn-BD"`, display headings use the sans stack (system serifs have no Bangla glyphs). Bangla pages are tested on Android and Windows before sign-off; if rendering is still poor, one Bangla font is self-hosted as a documented exception to the no-web-fonts rule. Tailwind `@theme` exposes `bx-*` colour utilities (`bg-bx-paper`, `text-bx-stone`, …) so custom markup never hard-codes greys.

The pre-paint script in `index.html` sets `data-theme="bengal"` and the `.dark` class from the saved/system mode, so there is no light flash. The mock's `data-mode="dark"` is **not** used: dark mode stays the `.dark` class driven by `hooks/use-theme.ts`, and the side menu's Light/Dark control calls that hook. There is no second theme switch.

### Shared storefront shell

- **Header** (`components/navbar.tsx`, rewritten): wordmark (diamond mark + serif name) · centre nav (Shop, Categories, Cart with count badge, Checkout, Contact) + search · right: mobile cart button and the **Menu** pill with avatar. Below 960 px the centre nav hides and a full-width search row appears.
- **Side menu** (new `components/side-menu.tsx`): HeroUI drawer/modal from the right with scrim; groups: Profile + Log in/out; Language select (7 locales) + Light/Dark segmented control; About, Blog, Contact; admins also get "Admin dashboard". Escape and scrim close it; focus is trapped.
- **Footer** (`components/footer.tsx`): brand blurb, existing-page links only, social, payment badges (only gateways that are on), copyright. Newsletter hidden.
- The floating palette (theme) button is removed; the mode lives in the side menu.
- Remove the Twitter/Discord/GitHub/translate/sun/"Sponsor"/⌘K clutter from the header (social moves to the footer).

### Storefront pages

| Page | Change |
|---|---|
| Home `/` | Hero (title, text, two buttons, "at a glance" list from real counts: marketplaces connected, categories, regions), featured carousel (dev placeholder / hidden in prod), "Shop the catalogue" grid with category filter chips, marketplaces strip (only channels that are connected) |
| `/products` | Same grid + chips + category list; on phone, categories become a horizontal chip row (today they are hidden) |
| Product card | Mock's card: 4:5 image tile, tag (e.g. "3 options"), serif title, rating, price ("From" when variants differ), variant chips, "Also on …" line when the product is mapped to marketplaces, Add to cart + save button |
| Product `/product/:id` | Two columns on desktop (gallery left, details right), stacked on phone; image no longer full-width; vendor/handle lines removed from the customer view |
| Cart / checkout | Mock typography and surfaces; summary card on the right on desktop |
| Login `/login` | Uses the theme (today it ignores dark mode); centred card on paper background |
| About, Blog, Order view, Success, 404 | Shell + typography only |
| Pricing, API page | Kept as they are but restyled; still login-only as today |
| `/openapi` | Swagger keeps the dark-mode inversion; label translated |

### Account pages

Shell as storefront. Account sidebar restyled (thin rules, indigo active state); dashboard welcome banner fixed (unreadable in dark today); stat cards use tokens instead of per-colour gradients; quick actions become ghost buttons.

### Admin (approach B)

New `layouts/admin.tsx` used by every `/admin/*` route:

```
┌──────────────┬──────────────────────────────────────────────┐
│ ◆ Bengal Ex. │  Page title             [search] [mode] [me] │
│              ├──────────────────────────────────────────────┤
│ Overview     │                                              │
│ CATALOG      │   page content (tables, forms)               │
│  Products    │                                              │
│  Categories  │                                              │
│  Inventory   │                                              │
│  Reviews     │                                              │
│ SALES        │                                              │
│  Orders      │                                              │
│  Customers   │                                              │
│  Analytics   │                                              │
│ CHANNELS     │                                              │
│  Marketplaces│                                              │
│  Webhooks    │                                              │
│ SETTINGS     │                                              │
│  Payments, Regions, Currencies, Countries, Warehouses,      │
│  Shipping rates/classes, Tax rates, Email templates, Users  │
│ ← View store │                                              │
└──────────────┴──────────────────────────────────────────────┘
```

Phone: sidebar becomes a drawer opened from the top bar. Tables and forms pick up the tokens; hard-coded greys/colours in admin pages are replaced with token classes. The admin home gets a short summary (recent orders, gateway status, marketplace status).

### i18n

New keys for the header, side menu, hero, carousel, catalogue, marketplaces strip, footer, admin sidebar groups and the OpenAPI label, in all seven locales. `bn-BD.json` is a full translation of the existing keys. The locale-parity test covers Bangla.

## Verification

**Admin baseline:** before admin work starts, capture screenshots of the current admin in dark mode (needs an admin session; see the audit below).

For every page touched: screenshots in light and dark at 390 px and 1440 px (Playwright), checked by eye, plus an axe scan; `npm run type-check`, `npm run lint`, `npm test` in `apps/client`; production build with bundle-size report; Lighthouse (mobile profile) on the home page for LCP and CLS. Backend: `npx tsc --noEmit` and `npm test` in `apps/merchant` for the label field.

## Dark-mode audit (2026-11-23, before the redesign)

| Page | Problem |
|---|---|
| `/login` | Ignores dark mode entirely: light gradient, white card |
| `/account` | Welcome banner has a light background with white text: name and email unreadable (desktop and phone) |
| `/account/preferences` | Phone field shows a red error before the user has typed |
| Product page | Shows "Vendor: Fufuni" (old demo data, not code) and the raw handle |
| All storefront pages, phone | Floating palette button covers content (e.g. "Manage the store" in the footer) |
| Home, phone | Category list is hidden; no way to filter by category |
| Pricing, About | Empty pages (title only) |
| Admin | **Not checked**: no admin session available to the check |

## Left to the builder

Exact spacing, motion details, component file boundaries, how to fetch "at a glance" counts (reuse existing endpoints; omit a figure rather than add an endpoint), and where the dev-only carousel fixtures live.
