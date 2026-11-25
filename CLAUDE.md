# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview
multicom (package name `bengal-exchange`) is a headless e-commerce framework that runs on Cloudflare Workers. It is an npm-workspaces monorepo orchestrated by Turborepo (`packageManager: npm@11`). Do not use pnpm or yarn.

| Workspace | What it is |
|---|---|
| `apps/merchant` | Backend: a Cloudflare Worker (Hono + `@hono/zod-openapi`) plus the `MerchantDO` Durable Object that holds all data in SQLite |
| `apps/client` | React 19 + Vite + HeroUI v3 SPA: storefront **and** admin panel (deployed to GitHub Pages) |
| `apps/mcp` | MCP knowledge server (a Worker on port 8788, plus a stdio build) |
| `apps/inspector` | Fork of the MCP Inspector UI (Jest tests) |
| `e2e` | Playwright end-to-end tests |

`package.json` also lists `apps/merchant/admin`, `apps/merchant/example` and `apps/cloudflare-worker` as workspaces, but none of them exist.

## Commands
All app scripts source the root `.env`, which is not committed (see `docs/run-instructions.md`).

```bash
npm install                      # root; installs every workspace
npm run dev                      # turbo: wrangler dev (merchant :8787) + vite (client :5173) + mcp
npm run dev:env                  # same, with .env loaded and stripe:listen running alongside
npm run build                    # turbo build
npm run clean:seed:start         # wipe local DO state, re-init, seed

# Backend (cd apps/merchant)
npm run db:init && npm run db:seed   # needs the worker running on :8787 and MERCHANT_SK in .env
npm run typegen                      # regenerate worker-configuration.d.ts from wrangler.jsonc
npm run gen:openapi                  # writes ../../openapi.json
npm test                             # vitest, tests/**/*.test.ts (auth.test.ts excluded: needs cloudflare:workers)
npx vitest run tests/variant-pricing.test.ts   # single file
npx vitest run -t "test name"                  # single test

# Client (cd apps/client)
npm run type-check
npm run lint                         # eslint --fix
npm test                             # vitest unit tests, src/**/*.test.ts (node env, no DOM)

# E2E (cd e2e)
npm run test:dev                     # against local dev (PLAYWRIGHT_ENV=local)
npm run test:dev:admin               # one project: public-chromium | auth-user | auth-admin
npx playwright test tests/<file>.spec.ts --project=public-chromium
```

CONTRIBUTING.md describes GitHub Actions workflows (`ci.yml` running typecheck + ESLint on PRs, plus deploys on push to `main`), but there is no `.github/` directory in this checkout, so run `type-check` and `lint` locally.

## Backend architecture (apps/merchant)
- **Entry point:** `src/index.ts` builds one `OpenAPIHono` app and mounts each router from `src/routes/*`. **Mount order matters:**
  - The KV cache and invalidation middleware (`middleware/kv-cache.ts`) must be registered with `app.use()` *before* `app.route()`.
  - Routes mounted before `rateLimitMiddleware` (sitemap, public orders/categories, SSLCommerz IPN) are not rate-limited.
  - `reviews` is mounted before `adminCatalog` because the catalog router applies `authMiddleware` to `*`.
  - Several routers share a prefix (`/v1/orders`, `/v1/products`, `/v1/carts`, `/v1/webhooks`). When adding a route, check for collisions.
- **Data layer:** there is no D1 or external database. All data lives in a single `MerchantDO` Durable Object (`src/do.ts`). Routes reach it through a `DOStub` and the `Database` `query`/`run` wrapper in `src/db.ts`. Some docs say "D1", but the storage is DO SQLite.
- **Schema changes need three edits made together** (from CONTRIBUTING):
  1. the `SCHEMA` constant in `do.ts`
  2. the inline migration array in `ensureInitialized()` in `do.ts`
  3. a numbered SQL file `migrations/NNN-description.sql`

  Migrations are additive only (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN`).
- **Auth:** Better Auth is the only identity system (Auth0 has been removed; only old migrations still mention it). `src/lib/auth.ts` builds `betterAuth` with the Drizzle adapter over `drizzle-orm/durable-sqlite`, using the DO's storage. It runs **inside `MerchantDO`** (the Worker forwards `/api/auth/*` to the DO). The Worker verifies sessions by asking the DO (`src/lib/session.ts`), and a session only gets the admin role if its email is in `ADMIN_EMAILS`. Its tables are defined in `src/db/schema.ts`, with migration `037-add-better-auth-tables.sql`. Middleware (`middleware/auth.ts`, `customer-auth.ts`) checks credentials in this order:
  1. Better Auth session cookie
  2. `sk_*` admin / `pk_*` public API keys (SHA-256 hashed in `api_keys`)
  3. 64-char hex OAuth tokens

  Order view links use signed tokens (`lib/order-token.ts`). Details are in `docs/authentication.md`.
- **Email verification:** sign-up emails a confirmation link (`lib/auth-email.ts`, Mailgun) and creates no session; sign-in for an unconfirmed email returns 403 `EMAIL_NOT_VERIFIED` and re-sends it. `customerAuthMiddleware` also rejects unconfirmed sessions. Without Mailgun the link is only logged (`console.warn`), so production needs `MAILGUN_API_KEY`/`MAILGUN_DOMAIN`. `ADMIN_EMAILS` users are auto-verified. The only role gate is `adminOnly`.
- **Customer data:** customer routes must get the customer from the session via `resolveCustomer(db, auth.userId)` in `src/lib/customers.ts` (it claims a guest row by email and links guest orders). Never take a customer id or email from the request. Any code that creates, refunds or changes the status of an order must keep customer totals right through the same file's helpers (`recalcCustomerStats`, `upsertCustomerByEmail`, `linkOrderToCustomer`, `refreshOrderCustomer`); totals are computed from orders, never incremented by hand.
- **Per-customer state is server-side:** the cart (`customer_carts`, `GET`/`PUT /v1/me/cart`), wishlist and saved carts (`customers.metadata`). The client keeps only a guest cart in localStorage and merges it into the account cart on sign-in (`hooks/use-cart.tsx`).
- **Payments:** Stripe (checkout + webhooks in `routes/checkout.ts` / `routes/webhooks.ts`) and SSLCommerz (`routes/sslcommerz-ipn.ts`).
- **Shared domain logic** lives in `src/lib/`: pricing, shipping, tax, inventory, webhooks and marketplace (Etsy/eBay/Amazon). Put new shared logic there.
- **UCP** (Universal Commerce Protocol, for AI shopping agents) is in `routes/ucp.ts`, exposed at `/.well-known/ucp` and `/ucp/v1/*`.
- **Bindings** (`wrangler.jsonc`): `MERCHANT` (DO), R2 `IMAGES` (bucket `multicom-images`) and `DIGITAL_ASSETS_BUCKET` (bucket `multicom-digital-assets`), KV `KV_CACHE` (response cache, rate limits, and the encrypted AI config under key `ai:config`).
- **AI config:** `ai.json.enc` is encrypted with `CRYPTOKEN`. Manage it with `npm run ai:encrypt` / `ai:decrypt` / `ai:kv:push`, and never commit a decrypted `ai.json`.

## Frontend conventions (apps/client)
- HeroUI components: use `onPress`, not `onClick`.
- **One theme, Bengal, with light and dark modes.** The pre-paint script in `index.html` sets `data-theme="bengal"` on `<html>`. Tokens live in `src/styles/themes/bengal.css`: the mock's `--bx-*` values are mapped onto HeroUI's variables, and `globals.css` exposes `bg-bx-*`/`text-bx-*`/`border-bx-*` utilities. Use those utilities or HeroUI tokens, not hard-coded colours.
  - Old slugs (`classic`, `luxury`, `luxury-dark`, `default`, `heroui_standard`) are ignored, so every visitor gets `bengal`; an old `ui-theme=luxury-dark` is converted once to a dark choice (`migrateLegacyTheme` in `src/lib/theme.ts`, mirrored in `index.html`). The `BENGAL_EXCHANGE_THEME` (or legacy `FUFUNI_THEME`) env value is defined but not read.
  - Dark mode is the `.dark` class on `<html>`, owned by `hooks/use-theme.ts`. The `dark:` variant follows only that class, not `prefers-color-scheme`. **Dark is the default** (`DEFAULT_MODE` in `src/lib/theme.ts`, mirrored in `index.html`); the OS setting is ignored. The mode is saved in localStorage `theme` only when the user picks Light/Dark (side menu or account preferences).
  - Palette: warm black with jute, gold, green and a little orange. Dark-mode primary is gold, light-mode primary is black. `--bx-jute/gold/green/orange` feed the gradient utilities in `globals.css` (`.bx-landing-glow` behind the home page, `.bx-gradient-text`, `.bx-cta-glow`, `.bx-gradient-rule`); the shell root is `relative isolate` so the glow's `z-index: -1` works.
  - The storefront shell (header, side menu, footer) is in `src/components/shell/`, styled by `src/styles/shell.css`. Links come from `src/config/navigation.ts`, which only allows existing routes and CMS pages.
  - Fonts are system stacks (no web fonts); headings use `font-display`, and Bangla falls back to sans.
- i18n: seven locales (`en-US`, `fr-FR`, `es-ES`, `zh-CN`, `ar-SA`, `he-IL`, `bn-BD`). The list is in `src/lib/languages.ts`; add each file's URL in `src/i18n.ts`. `<html lang/dir>` is set globally on every language change. `src/__tests__/i18n.test.ts` checks that every locale has exactly the en-US keys, allowing language-specific plural forms.
- i18n locale files are in `src/locales`. Product and category titles/descriptions can be plain text or per-locale JSON (RTL is supported).
- `apps/client/CLIENT_BLUEPRINT.md` and `apps/merchant/BACKEND_BLUEPRINT.md` contain deeper per-app design notes.

## Code style
- TypeScript strict mode. Do not use `any` without a comment explaining why.
- Backend tests go in `apps/merchant/tests/`. To test routes against the real schema, use `tests/helpers/merchant-db.ts`, which runs `MerchantDO` (real `SCHEMA` + migrations) on `node:sqlite`. `cloudflare:workers` is aliased to a stub in `vitest.config.ts`. CONTRIBUTING mentions `src/routes/__tests__/`, but that directory does not exist.
