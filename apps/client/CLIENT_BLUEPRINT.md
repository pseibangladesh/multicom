# Client Frontend Customization Blueprint

**Purpose:** Guide developers through customizing the frontend for multiple clients with distinct design expectations — brand identity, layout patterns, component styles, and theme systems.

---

## 1. Architecture Overview

The client app is a **Vite + React 19 + HeroUI** SPA that talks to the merchant worker via REST/cookie auth. Customization happens at five layers:

| Layer | What it controls | Where it lives |
|-------|-----------------|----------------|
| **Theme (CSS variables)** | Colours, radii, shadows, fonts, spacing tokens | `src/styles/globals.css` + `src/styles/themes/*.css` |
| **Layout** | Page chrome — navbar, footer, main container width/padding | `src/layouts/default.tsx`, `src/layouts/luxury.tsx` |
| **Components** | Reusable UI building blocks (cards, carousels, nav) | `src/components/`, `src/shared/ui/` |
| **Pages** | Route-level views that compose components | `src/pages/` |
| **Config** | Site name, nav items, social links, env-driven flags | `src/config/site.ts`, Vite `env.*` blocks in `vite.config.ts` |

Each layer is **independent** — you can swap a layout without touching the theme, or change colours without changing component structure.

---

## 2. Theme Customization

### 2.1 How Theming Works

The app uses **CSS custom properties scoped to `[data-theme="…"]`** on `<html>`. HeroUI reads these variables and maps them to its own design tokens.

```
data-theme="default"  →  no attribute (HeroUI baseline)
data-theme="luxury"   →  sharp edges, warm neutrals, zero radius
data-theme="luxury-dark" →  dark luxury variant
```

### 2.2 Adding a New Theme

1. **Create the CSS file:**

   ```
   src/styles/themes/my-brand.css
   ```

2. **Declare `[data-theme="my-brand"]` and `[data-theme="my-brand-dark"]` blocks.** Use `oklch()` colours for perceptually uniform contrast. Key variables:

   | Variable group | Purpose |
   |---------------|---------|
   | `--background`, `--foreground` | Page background + body text |
   | `--surface`, `--surface-*` | Cards, panels, drawer backgrounds |
   | `--primary`, `--primary-foreground` | Buttons, links, active states |
   | `--accent`, `--accent-foreground` | Secondary actions |
   | `--border`, `--separator` | Dividers, input borders |
   | `--radius`, `--field-radius` | Border radius (0 for sharp, 8+ for soft) |
   | `--font-sans`, `--font-serif` | Font families |

3. **Import the theme in `globals.css`:**

   ```css
   @import "./themes/my-brand.css" layer(theme);
   ```

4. **Register the slug in `src/providers/theme-provider.tsx`:**

   ```ts
   export const AVAILABLE_THEMES = ["default", "luxury", "my-brand", "my-brand-dark"] as const;
   ```

### 2.3 Quick Colour Swap (No New Theme File)

If you only need different colours, override in `globals.css` inside an existing theme block:

```css
@layer base {
  [data-theme="default"] {
    --background: #fefefe;
    --foreground: #1a1a2e;
    --primary: #6366f1;
    --radius: 12px;
  }
}
```

---

## 3. Layout Customization

### 3.1 Layout Files

| File | Use case |
|------|----------|
| `src/layouts/default.tsx` | Standard e-commerce layout (navbar + container + footer) |
| `src/layouts/luxury.tsx` | Full-bleed editorial layout (no side padding, dark footer) |

### 3.2 Creating a Custom Layout

1. **Create the layout component:**

   ```tsx
   // src/layouts/my-client.tsx
   import { Navbar } from "@/components/navbar";
   import { CartDrawer } from "@/components/cart-drawer";
   import { Footer } from "@/components/footer";
   import type React from "react";

   export default function MyClientLayout({ children }: { children: React.ReactNode }) {
     return (
       <div className="relative flex flex-col min-h-screen">
         <Navbar variant="floating" /> {/* or custom props */}
         <main className="w-full grow pt-16">{children}</main>
         <Footer type="minimal" />
       </div>
     );
   }
   ```

2. **Register it in `src/app.tsx`:**

   ```tsx
   import MyClientLayout from "@/layouts/my-client";
   // ...
   <Route element={<MyClientLayout><IndexPage /></MyClientLayout>} path="/" />
   ```

3. **Or use it as a wrapper around `<Routes>` for global application:**

   ```tsx
   return (
     <MyClientLayout>
       <Routes>{/* ... */}</Routes>
     </MyClientLayout>
   );
   ```

### 3.3 Navbar Customization

The navbar is in `src/components/navbar.tsx`. It accepts no props currently — to customize per-client:

- **Logo:** Replace the `<Logo />` component or render custom JSX
- **Menu items:** Edit the nav links directly (they come from `siteConfig().navItems`)
- **Search bar:** Add/remove the search input in the navbar JSX
- **Cart icon:** Controlled by `useCartDrawer()`

---

## 4. Component Customization

### 4.1 Shared UI Components

Located in `src/shared/ui/`. These are layout-agnostic building blocks:

| Directory | Contents |
|-----------|----------|
| `buttons/` | CopyButton, shared button styles |
| `feedback/` | SiteLoading, EmptyCard, LoadingPane |
| `navigation/` | ThemeSwitcher, LanguageSwitch |
| `overlays/` | CookieConsent |
| `admin/` | Admin CRUD layout, status badges, row actions |

### 4.2 Store Components

Located in `src/components/`. These are e-commerce-specific:

| Component | Customization points |
|-----------|---------------------|
| `product-card.tsx` | Image aspect ratio, price display, badge overlays |
| `product-card-full.tsx` | Grid/list toggle, column count |
| `cart-drawer.tsx` | Slide-in panel layout, quantity controls |
| `navbar.tsx` | Logo, search, nav links, cart icon |
| `footer.tsx` | Column layout, social links, payment badges |
| `category-nav.tsx` | Horizontal scroll vs dropdown |

### 4.3 Creating a Client-Specific Component Variant

Use **composition** — create a new component that wraps or replaces the default:

```tsx
// src/components/my-client/product-card.tsx
import { ProductCard as DefaultProductCard } from "@/components/product-card";

export function ProductCard(props) {
  return (
    <div className="rounded-2xl shadow-lg border-2">
      <DefaultProductCard {...props} />
    </div>
  );
}
```

Then import the variant in your layout or page instead of the default.

---

## 5. Page Customization

### 5.1 Page Structure

| Route | Component | Notes |
|-------|-----------|-------|
| `/` | `IndexPage` | Standard product grid with category nav |
| `/index-luxury` | `IndexLuxuryPage` | Hero banner + carousel + bento grid |
| `/login` | `LoginPage` | Email/password or magic link |
| `/product/:id` | `ProductPage` | Detail view |
| `/cart` | `CartPage` | Cart summary |
| `/account/*` | AccountLayout + sub-pages | Dashboard, orders, addresses, preferences |
| `/pages/:handle` | `CmsPage` | Dynamic CMS pages |

### 5.2 Creating a Client Landing Page

1. **Create the page component:**

   ```tsx
   // src/pages/my-client-home.tsx
   import MyClientLayout from "@/layouts/my-client";
   import { HeroSection } from "@/components/hero-section";
   import { FeaturedProducts } from "@/components/featured-products";

   export default function MyClientHome() {
     return (
       <MyClientLayout>
         <HeroSection />
         <FeaturedProducts />
       </MyClientLayout>
     );
   }
   ```

2. **Add the route in `src/app.tsx`:**

   ```tsx
   import MyClientHome from "@/pages/my-client-home";
   // ...
   <Route element={<MyClientHome />} path="/" />
   ```

---

## 6. Site Configuration

### 6.1 `src/config/site.ts`

Controls:
- **Site name & description** — pulled from i18n translations
- **Navigation items** — array of `{ label, href, permissions }` objects
- **Social links** — GitHub, Twitter/X, Discord, Sponsor

To customize per-client, modify the `navItems` and `navMenuItems` arrays. Each item supports a `permissions` array for role-based visibility.

### 6.2 Environment Variables (Vite)

Defined in `vite.config.ts` under `define`. Override per-client via `.env` files:

| Variable | Purpose |
|----------|---------|
| `STORE_URL` | Backend API base URL |
| `STORE_NAME` | Display name for the store |
| `BENGAL_EXCHANGE_THEME` | Default theme slug (`default`, `luxury`, custom) |
| `ADMIN_AUTH0_PERMISSION` | Legacy permission (still used in guards) |

### 6.3 i18n / Translations

Located in `src/locales/base/en-US.json`. Add new translation keys here, then reference them with `t("key")` in components. The system supports runtime language switching via `react-i18next`.

---

## 7. Multi-Client Deployment Strategy

### 7.1 Single Codebase, Multiple Themes (Recommended)

Deploy one frontend bundle that detects the client from:
- **Subdomain** (`clientA.store.com` → theme=client-a)
- **Query parameter** (`?theme=client-b`)
- **Customer metadata** (JWT token carries `theme` in `user_metadata`)

Implementation: Read the domain or params in `src/main.tsx` and set `data-theme` before React mounts.

### 7.2 Separate Builds per Client

Use Vite's `build.target` or duplicate `vite.config.ts` per client:

```
apps/client/
  vite.config.ts          # default client
  vite.client-b.config.ts # different client
```

Build with: `vite build --config vite.client-b.config.ts`

### 7.3 Component Swapping at Build Time

Use Vite's `optimizeDeps.exclude` or Rollup's `alias` to swap entire component directories per build target.

---

## 8. Design System Reference

### 8.1 Color Palette Tokens

All colours use **oklch()** for perceptual uniformity. Current defaults:

| Token | Default value | Usage |
|-------|--------------|-------|
| `--brand` | `#171717` | Primary brand colour |
| `--brand-50` through `--brand-900` | Neutral scale | Surfaces, text |

### 8.2 Typography

| Token | Default font | Usage |
|-------|-------------|-------|
| `--font-sans` | Inter, Helvetica Neue | Body text, UI |
| `--font-serif` | Playfair Display, Georgia | Headings (luxury theme) |

### 8.3 Spacing & Radius

| Token | Default | Usage |
|-------|---------|-------|
| `--radius` | HeroUI default (varies by theme) | Cards, buttons, inputs |
| `--field-radius` | HeroUI default | Form fields specifically |
| `--border-width` | 1px | Borders |

---

## 9. Quick Reference: Files to Edit Per Client

| Goal | File(s) to modify |
|------|-------------------|
| Change colours / fonts | `src/styles/themes/*.css`, `globals.css` |
| Change layout (header/footer) | `src/layouts/*.tsx` |
| Change navbar content | `src/components/navbar.tsx` |
| Change footer content | `src/components/footer.tsx` |
| Change product card style | `src/components/product-card*.tsx` |
| Change site name / nav links | `src/config/site.ts` |
| Add a new page | `src/pages/` + `src/app.tsx` |
| Change default theme | `vite.config.ts` env block or `.env` |
| Add translation strings | `src/locales/base/en-US.json` |
| Register new theme slug | `src/providers/theme-provider.tsx` |

---

## 10. Common Customization Patterns

### 10.1 Remove the Cart Icon from Navbar

```tsx
// In navbar.tsx, remove or conditionally render the cart button
{showCart && <button onClick={onCartOpen}>...</button>}
```

### 10.2 Full-Bleed Product Images (No Container)

```tsx
// In a custom layout, replace the container main:
<main className="w-full grow pt-16">{children}</main>
```

### 10.3 Custom Loading State

Replace `src/shared/ui/feedback/site-loading.tsx` with a branded spinner or animated logo.

### 10.4 Disable Cookie Consent

Set `needCookieConsent: false` in `src/config/site.ts`.

---

## 11. Testing Your Changes

1. **Local dev:** `npm run dev` from `apps/client/`
2. **Verify theme:** Check that `data-theme` attribute appears on `<html>` when the theme is active
3. **Verify layout:** Navigate to multiple routes and confirm consistent chrome
4. **Verify mobile:** Test responsive breakpoints (navbar collapses, grid adapts)
5. **Verify auth flows:** Login, session persistence, logout all work with custom components

---

## 12. Gotchas & Pitfalls

- **HeroUI token names change between major versions.** Always check `@heroui/react` version in `package.json`.
- **`data-theme` is global.** If two clients share a page, the last-set theme wins. Use route-level theming to isolate.
- **i18n keys are shared.** Adding a key for one client affects all — scope keys with namespaces if needed (`t("clientA:header.title")`).
- **Tailwind v4 has no config file.** All Tailwind customizations go in CSS via `@theme` or `@layer`. Don't look for `tailwind.config.js`.
- **The `luxury` theme uses zero radius (`--radius: 0px`).** Components that hardcode `rounded-*` classes will override the theme — use `rounded-none` explicitly where needed.
