<div align="center">
  <h1>🛍️ Bengal Exchange</h1>
  <p><strong>A headless, AI-ready e-commerce platform that runs entirely on Cloudflare's edge.</strong><br/>
  Cloudflare Workers · Durable Objects (SQLite) · React 19 · Better Auth · Stripe · SSLCommerz</p>
</div>

---

Bengal Exchange is a full online store: a storefront, an admin dashboard and a backend API. It sells physical and digital products in several currencies and languages. Payments go through Stripe or SSLCommerz. Orders can also come in from Etsy, eBay and Amazon, and AI shopping agents can place them through the Universal Commerce Protocol (UCP).

The backend is a single Cloudflare Worker. All store data lives in one Durable Object's SQLite database, so there is no external database to run.

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Admin access](#admin-access)
- [Payments](#payments)
- [Common commands](#common-commands)
- [Testing](#testing)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Features

**Catalog**
- Products with variants, SKUs, weights and per-region prices
- Physical and digital products (digital files stored in R2 with signed download links)
- Hierarchical categories, product reviews with moderation
- Product titles and descriptions per locale (rich HTML editor), with one-click AI translation
- Images on Cloudflare R2

**Selling**
- Cart, checkout and orders, with inventory reserved per warehouse
- Multiple regions, currencies, countries and warehouses
- Shipping rates and shipping classes, tax rates
- Discount codes (fixed or percentage), synced to Stripe coupons
- Configurable order emails per order status (Mailgun), with AI translation
- Outbound webhooks signed with HMAC (`X-Bengal-Exchange-Signature`)

**Payments**
- **Stripe** Checkout with webhook reconciliation and refunds
- **SSLCommerz** (Bangladesh), with server-side payment validation
- Turn each gateway on or off, and enter its keys, from **Admin → Payment Gateways**

**Customers**
- Email + password accounts (Better Auth), address book, order history
- Wishlist and saved carts
- Admin access limited to the addresses in `ADMIN_EMAILS`

**Marketplaces**
- Etsy, eBay and Amazon (SP-API) connectors: connect from the dashboard, push listings, price and stock, import orders every 15 minutes, send tracking back
- Amazon offers a product on the existing catalog listing when its barcode matches; buyer details need Amazon's restricted role (orders import without them otherwise)

**AI**
- UCP endpoints (`/.well-known/ucp`, `/ucp/v1/*`) so AI agents can browse and check out
- An MCP knowledge server (`apps/mcp`) that explains this codebase to coding assistants
- AI translation and review-moderation suggestions in the admin dashboard

**Storefront**
- React 19 single-page app served from GitHub Pages or any static host
- Themes (`classic`, `luxury`) switchable from the admin dashboard
- 6 languages: English, French, Spanish, Chinese, Arabic and Hebrew (right-to-left supported)

## Architecture

```
            Browser (storefront + admin SPA)          AI agents / marketplaces
                         │                                      │
                         ▼                                      ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │ Cloudflare Worker  (Hono + @hono/zod-openapi, apps/merchant)          │
   │   /v1/*  REST API     /api/auth/*  Better Auth     /ucp/v1/*  UCP     │
   │   KV response cache · rate limiting · Stripe / SSLCommerz webhooks    │
   └──────────────┬─────────────────────────────┬──────────────────────────┘
                  │                             │
                  ▼                             ▼
   ┌──────────────────────────────┐   ┌──────────────────────────────────┐
   │ MerchantDO (Durable Object)  │   │ R2: product images, digital files │
   │ SQLite: catalog, orders,     │   │ KV: cache, rate limits, AI config │
   │ customers, auth, settings    │   │ Queue: marketplace sync jobs      │
   └──────────────────────────────┘   └──────────────────────────────────┘
```

- **One database:** every route reaches the store's SQLite database through the `MerchantDO` Durable Object. There is no D1 or external database.
- **Auth:** Better Auth runs inside the Durable Object. Storefront sessions use an HttpOnly cookie. Scripts and integrations use API keys: `sk_…` for admin, `pk_…` for public. A session gets admin rights only if its email is listed in `ADMIN_EMAILS`.
- **API docs:** the OpenAPI spec is generated from the route schemas. Browse it at `http://localhost:8787/docs` (Swagger UI).

More detail: [docs/system-design.md](docs/system-design.md), [docs/authentication.md](docs/authentication.md).

## Repository layout

An npm-workspaces monorepo run by Turborepo. Use **npm** (not pnpm or yarn).

| Path | What it is |
|---|---|
| `apps/merchant` | Backend: Cloudflare Worker + `MerchantDO` Durable Object (port 8787) |
| `apps/client` | Storefront **and** admin dashboard: React 19 + Vite + HeroUI (port 5173) |
| `apps/mcp` | MCP knowledge server for AI coding assistants (port 8788) |
| `apps/inspector` | MCP Inspector UI (fork) |
| `e2e` | Playwright end-to-end tests |
| `docs` | Setup, production and design documentation |
| `scripts` | Repo-level helper scripts |

## Quick start

Requirements: Node.js 20+, npm 11, and the Wrangler CLI (`npm i -g wrangler`).

```bash
# 1. Install
git clone https://github.com/pseibangladesh/multicom.git
cd multicom
npm install

# 2. Configure: create .env (root) and apps/client/.env
#    Templates and every variable: docs/run-instructions.md, section 2.
#    Put your own email in ADMIN_EMAILS.

# 3. Start the backend and the storefront (copies .env into apps/merchant/.dev.vars)
npm run dev:env

# 4. In a second terminal: create the database schema, API keys and base data
npx tsx apps/merchant/scripts/init.ts

# 5. Create your admin login (asks for a password)
npx tsx apps/merchant/scripts/create-admin.ts you@example.com

# 6. Optional: load demo products, regions and orders (safe to re-run)
npx tsx apps/merchant/scripts/seed.ts http://localhost:8787 <MERCHANT_SK>
```

| Service | URL |
|---|---|
| Storefront | http://localhost:5173 |
| Admin dashboard | http://localhost:5173/admin |
| API | http://localhost:8787 |
| API docs (Swagger) | http://localhost:8787/docs |

The full walkthrough, including Stripe, Mailgun, marketplaces and troubleshooting, is in **[docs/run-instructions.md](docs/run-instructions.md)**.

## Admin access

Admins never use the public sign-up form, which refuses any address listed in `ADMIN_EMAILS`. To create an admin:

1. Add the email to `ADMIN_EMAILS` in `.env` and restart with `npm run dev:env`.
2. Run `npx tsx apps/merchant/scripts/create-admin.ts you@example.com` and choose a password.
3. Sign in at `/login`, then open `/admin`.

Forgot the password? Run the same command with `--reset-password`. For a deployed worker, add `--remote`. Details: [docs/run-instructions.md §3.2](docs/run-instructions.md).

## Payments

Configure both gateways from **Admin → Payment Gateways** (`/admin/payment-gateways`):

| Gateway | What you enter | Notes |
|---|---|---|
| Stripe | Publishable key, secret key, webhook signing secret | Stripe must accept the secret key before it is saved. The card shows test/live mode and the webhook URL to add in Stripe. Falls back to the `STRIPE_*` env variables when nothing is saved. |
| SSLCommerz | Store ID, store password, sandbox switch | Payments are confirmed server-side with SSLCommerz's validation API. |

Secrets are encrypted with `CRYPTOKEN` before they are stored. The checkout only offers gateways that are switched on (`GET /v1/payment-methods`). Switching Stripe off leaves refunds and webhooks for existing orders working.

For local Stripe webhooks: `npm run stripe:listen`.

## Common commands

```bash
npm run dev                 # backend + storefront + MCP server (no .env copy)
npm run dev:env             # same, with .env loaded and copied to apps/merchant/.dev.vars
npm run build               # build every workspace
npm run clean:seed:start    # wipe local data, re-init, seed, start

# Backend (cd apps/merchant)
npm test                    # Vitest
npm run gen:openapi         # write ../../openapi.json
npm run typegen             # regenerate worker types from wrangler.jsonc

# Storefront (cd apps/client)
npm run type-check
npm run lint
npm test

# AI config (encrypted with CRYPTOKEN; never commit a decrypted ai.json)
npm run ai:encrypt | ai:decrypt | ai:kv:push
```

## Testing

| Suite | Command | Notes |
|---|---|---|
| Backend unit + route tests | `cd apps/merchant && npm test` | Runs the real `MerchantDO` schema on `node:sqlite` (`tests/helpers/merchant-db.ts`) |
| Storefront unit tests | `cd apps/client && npm test` | Node environment, no DOM |
| End-to-end | `cd e2e && npm run test:dev` | Playwright against the local dev servers |

A few backend integration suites (`advanced-routes`, `regions.integration`, `variant-pricing`) need a running worker and a `.env` at a fixed path, so they fail in a plain `npm test` run.

## Deployment

- **Backend:** `cd apps/merchant && npx wrangler deploy`. Then set the secrets with `npx wrangler secret put …` (`BETTER_AUTH_SECRET`, `MERCHANT_SK`, `ADMIN_EMAILS`, `CRYPTOKEN`, …).
- **First run:** initialise the remote store with `init.ts --remote`, then create the first admin with `create-admin.ts --remote`.
- **Storefront:** `npm run build:client:env`, then publish `apps/client/dist` to GitHub Pages or any static host.

Follow **[docs/production-checklist.md](docs/production-checklist.md)** before going live.

## Documentation

| Document | Contents |
|---|---|
| [docs/run-instructions.md](docs/run-instructions.md) | Local setup, environment variables, admin creation, seeding, external services |
| [docs/production-checklist.md](docs/production-checklist.md) | Secrets, admin setup and checks before launch |
| [docs/authentication.md](docs/authentication.md) | Sessions, API keys, OAuth, admin rules |
| [docs/system-design.md](docs/system-design.md) | Architecture and design decisions |
| [docs/current-database-schema.md](docs/current-database-schema.md) | Database tables |
| [docs/roadmap-marketplace-integrations.md](docs/roadmap-marketplace-integrations.md) | Etsy / eBay / Amazon plans |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution rules |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Contributing

1. Create a feature branch from `main`.
2. Database changes are additive only. Update the `SCHEMA` constant and the inline migration in `apps/merchant/src/do.ts`, and add a numbered file in `apps/merchant/migrations/`.
3. New API routes need Zod-OpenAPI schemas. Put shared business logic in `apps/merchant/src/lib/`.
4. TypeScript strict mode. In the storefront, HeroUI components use `onPress`, not `onClick`.
5. Run the type-checks, lint and tests before opening a pull request.

## License

Bengal Exchange is built on the open-source project by Ronan LE MEILLAT / SCTG Development, and keeps its licenses:

- `apps/client/`: **AGPL-3.0-or-later** (stated in each source file's header)
- `apps/merchant/`: **MIT** (see [apps/merchant/LICENSE](apps/merchant/LICENSE))

Under the AGPL, if you run a modified storefront for users over a network, you must offer them its source code.
