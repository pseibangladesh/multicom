# Bengal Redesign — Phase 1 (theme, mode, shell, i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every client page the Bengal theme (light + dark), a new header, side menu and footer, and seven-language i18n including Bangla, without touching page bodies, the carousel, the admin or the backend.

**Architecture:** One CSS theme (`data-theme="bengal"`) maps the mock's tokens onto HeroUI v3 variables, so every existing component restyles itself; dark mode stays the `.dark` class owned by `hooks/use-theme.ts`. The storefront shell (`layouts/default.tsx`) is rebuilt from three components: `SiteHeader`, `SideMenu`, `SiteFooter`. Language direction and `lang` move out of the header switch into `i18n.ts` so they apply globally.

**Tech Stack:** React 19, HeroUI v3 (`@heroui/react`, `@heroui/styles`), Tailwind 4, i18next, Vite 8, Vitest (node env), Playwright + axe-core (root `node_modules`) for screenshots and checks.

**Spec:** `docs/superpowers/specs/2026-11-23-bengal-redesign-design.md`, amended by `claude/bengal-redesign-decisions.md` (the decisions note wins on conflict).

## Global Constraints

- Scope is phase 1 only: theme tokens, light/dark mode, header, side menu, footer, i18n scaffolding. No carousel, no admin layout, no backend change, no page-body redesign.
- Dark mode is the `.dark` class on `<html>` driven by `hooks/use-theme.ts`; no second theme switch; the mock's `data-mode` is not used.
- Only the `bengal` theme. Slugs `classic`, `luxury`, `luxury-dark`, `default`, `heroui_standard`, empty and unknown all resolve to `bengal`.
- `vite.config.ts` keeps `import.meta.env.BENGAL_EXCHANGE_THEME`, falling back to `FUFUNI_THEME`; both resolve to `bengal`.
- No blocking web fonts: remove the Google Fonts links; sans stack `"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, -apple-system, "Noto Sans Bengali", "Kohinoor Bangla", "Nirmala UI", sans-serif`; display stack `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif`; when `<html lang="bn-BD">`, display headings use the sans stack.
- No decorative shadows/gradients; radius `4px`; max content width `1240px`; gutter `clamp(1rem, 4vw, 2.5rem)`.
- Seven locales: `en-US` (default), `fr-FR`, `es-ES`, `zh-CN`, `ar-SA` (RTL), `he-IL` (RTL), `bn-BD` (`বাংলা`). Every locale file has exactly the keys of `en-US`.
- HeroUI buttons use `onPress`; TypeScript strict; no `any` without a comment.
- Newsletter form hidden. Footer links only to routes or `/pages/:handle` entries that exist in `config/cms-content.ts`.
- Do not commit; the owner commits. Each task ends with type-check + tests instead.
- Accessibility: visible focus (`outline: 2px solid var(--bx-accent); outline-offset: 3px`), side menu operable by keyboard (Escape closes, focus trapped and returned), `prefers-reduced-motion` disables transitions.

## Review Focus

- OS in dark mode, user picks **Light** → page must be fully light (HeroUI's `dark:` variant falls back to `prefers-color-scheme`; the override in Task 2 must stop that). Test: Task 2 screenshot step with `colorScheme: 'dark'` + stored `light`.
- Returning visitor with `ui-theme=luxury-dark` or `theme=dark` in localStorage → no light flash, bengal dark on first paint. Test: Task 1 unit tests + Task 7 screenshot with seeded storage.
- Arabic/Hebrew chosen, then header language switch removed → page must still render RTL after reload. Test: Task 3 `languageDirection` tests + Task 7 `ar-SA` screenshot.
- Long German-length / Bangla labels in the header at 390 px → no horizontal scroll. Test: Task 7 asserts `scrollWidth <= innerWidth` for every page/locale shot.
- Side menu opened then route changes or Escape pressed → menu closes and focus returns to the Menu button. Test: Task 5 Playwright step.

---

### Task 1: Theme resolution and mode (no flash, one theme)

**Files:**
- Create: `apps/client/src/lib/theme.ts`
- Test: `apps/client/src/__tests__/theme.test.ts`
- Modify: `apps/client/src/hooks/use-theme.ts`, `apps/client/src/providers/theme-provider.tsx`, `apps/client/index.html`, `apps/client/vite.config.ts:105`, `apps/client/src/App.tsx` (route `/index-luxury`), `apps/client/src/pages/account/preferences.tsx` (Appearance section)
- Delete: `apps/client/src/components/ui/theme-switcher.tsx`, `apps/client/src/layouts/luxury.tsx`, `apps/client/src/pages/index-luxury.tsx`, `apps/client/src/styles/themes/luxury.css`

**Interfaces:**
- Produces: `BENGAL_THEME = "bengal"`; `normalizeThemeSlug(slug: string | null | undefined): "bengal"`; `type ColorMode = "light" | "dark"`; `resolveMode(stored: string | null, prefersDark: boolean): ColorMode`; `MODE_STORAGE_KEY = "theme"`. `useTheme()` keeps its return shape `{ theme, isDark, isLight, setLightTheme, setDarkTheme, toggleTheme }`. `StoreThemeProvider` keeps its name.

- [ ] **Step 1: Write failing tests** in `theme.test.ts`:

```ts
it("maps every old or unknown slug to bengal", () => {
  for (const s of ["classic", "luxury", "luxury-dark", "default", "heroui_standard", "", null, undefined, "neon"])
    expect(normalizeThemeSlug(s)).toBe("bengal");
});
it("uses the stored mode, else the system preference", () => {
  expect(resolveMode("dark", false)).toBe("dark");
  expect(resolveMode("light", true)).toBe("light");
  expect(resolveMode(null, true)).toBe("dark");
  expect(resolveMode("luxury-dark", false)).toBe("light"); // garbage → system
});
```

- [ ] **Step 2:** `cd apps/client && npx vitest run src/__tests__/theme.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/theme.ts`. Rewrite `use-theme.ts`: initial state `resolveMode(localStorage.getItem("theme"), matchMedia("(prefers-color-scheme: dark)").matches)` (guard `typeof window`/try-catch); `_applyToDom` sets the `light|dark` class, `data-theme="bengal"`, `style.colorScheme`, stores the mode; delete all luxury syncing. `theme-provider.tsx`: keep `THEME_UPDATED_EVENT` and `StoreThemeProvider` (now only ensures `data-theme="bengal"` on mount); delete `useStoreTheme`, `AVAILABLE_THEMES`, `ThemeSlug`, `getThemeFromToken`, `applyTheme`. `index.html`: inline pre-paint script before the module script that sets `data-theme="bengal"`, the mode class (same rule as `resolveMode`, try/catch), `lang`/`dir` from `localStorage.preferredLanguage` (RTL for `ar-SA`, `he-IL`); remove the Google Fonts `<link>`s and the "luxury" comment; `<meta name="color-scheme" content="light dark">`. `vite.config.ts:105`: `process.env.BENGAL_EXCHANGE_THEME ?? process.env.FUFUNI_THEME ?? "bengal"`. `App.tsx`: `/index-luxury` → `<Navigate to="/" replace />`. Preferences "Appearance": replace the theme select with a Light/Dark choice wired to `useTheme()` (keys `account-mode`, `mode-light`, `mode-dark`, added in Task 3). Remove `<ThemeSwitcher />` from `layouts/default.tsx`. Delete the four files listed.
- [ ] **Step 4:** `npx vitest run src/__tests__/theme.test.ts` → PASS; `npm run type-check` → no errors.

### Task 2: Bengal tokens on HeroUI

**Files:**
- Create: `apps/client/src/styles/themes/bengal.css`
- Modify: `apps/client/src/styles/globals.css`

**Interfaces:**
- Produces CSS custom properties `--bx-paper --bx-surface --bx-surface-raised --bx-ink --bx-ink-soft --bx-stone --bx-line --bx-primary --bx-on-primary --bx-indigo-tint --bx-accent --bx-accent-soft --bx-scrim` (values: spec "Tokens" table, light under `:root[data-theme="bengal"]`, dark under `:root[data-theme="bengal"].dark`), Tailwind colour utilities `bg-bx-*`, `text-bx-*`, `border-bx-*` (via `@theme inline { --color-bx-paper: var(--bx-paper); … }`), utility `font-display`, and the container class `bx-wrap` (max 1240px, gutter clamp).

- [ ] **Step 1:** Write `bengal.css` in `@layer base`: the `--bx-*` tokens, then HeroUI variables from them — `--background: paper`, `--background-secondary: surface`, `--foreground: ink`, `--surface/--overlay/--field-background: surface-raised`, `--surface-secondary: surface`, `--surface-tertiary: indigo-tint`, `*-foreground: ink`, `--muted: stone`, `--border/--separator/--field-border: line`, `--accent/--focus/--link: primary`, `--accent-foreground: on-primary`, `--accent-soft: indigo-tint`, `--accent-soft-foreground: primary`, `--default: indigo-tint`, `--default-foreground: ink`, `--segment: surface-raised`, `--radius/--field-radius: 4px`, `--surface-shadow/--overlay-shadow/--field-shadow: none` (overlay keeps the mock's `--shadow`). Leave danger/success/warning at HeroUI defaults.
- [ ] **Step 2:** `globals.css`: replace `@import "./themes/luxury.css"` with `bengal.css`; drop the luxury `@layer components` block and the brand scale; set `--font-sans`/`--font-serif` (display) stacks from Global Constraints; body uses `var(--bx-paper)`/`var(--bx-ink)`; `html[lang="bn-BD"] .font-display { font-family: var(--font-sans) }`; global `:focus-visible` outline; reduced-motion block; and override the dark variant so only the class counts: `@custom-variant dark (&:where(.dark, .dark *));` (placed after `@import "@heroui/styles"`). Keep the Swagger dark rule.
- [ ] **Step 3:** `npm run type-check && npx vite build` → success.
- [ ] **Step 4:** Screenshot `/` and `/cart` with the scratchpad `shoot.mjs` in four combinations, including OS dark + stored `light` → page is light (Review Focus 1). Expected: paper/ink colours, indigo buttons, no light flash in dark.

### Task 3: i18n — seven languages, global direction, parity

**Files:**
- Modify: `apps/client/src/i18n.ts`, `apps/client/src/shared/ui/navigation/language-switch.tsx`, all `src/locales/base/*.json`, `apps/client/src/components/openapi.tsx`
- Create: `apps/client/src/locales/base/bn-BD.json`
- Test: `apps/client/src/__tests__/i18n.test.ts`

**Interfaces:**
- Produces: `availableLanguages` gains `{ code: "bn-BD", nativeName: "বাংলা", isRTL: false }`; `languageDirection(code: string): "rtl" | "ltr"`; `applyLanguage(code: string): Promise<void>` (changes i18n language, stores `preferredLanguage`, sets `document.documentElement.lang` and `.dir`); i18n's `languageChanged` handler also sets `lang`/`dir`, so direction no longer depends on `LanguageSwitch` being mounted.
- New keys (all seven locales): `nav-shop`, `nav-categories`, `nav-cart`, `nav-checkout`, `nav-contact`, `menu`, `menu-close`, `menu-profile`, `menu-admin`, `menu-language`, `menu-theme`, `mode-light`, `mode-dark`, `account-mode`, `menu-about`, `menu-blog`, `search-products`, `skip-to-content`, `footer-blurb`, `openapi-download`.

- [ ] **Step 1: Write failing tests** in `i18n.test.ts` (import JSON files directly, as `marketplace-admin.test.ts` does):

```ts
it("lists seven languages with Bangla", () => {
  expect(availableLanguages.map((l) => l.code)).toEqual(["en-US","fr-FR","es-ES","zh-CN","ar-SA","he-IL","bn-BD"]);
});
it("knows text direction", () => {
  expect(languageDirection("ar-SA")).toBe("rtl"); expect(languageDirection("he-IL")).toBe("rtl");
  expect(languageDirection("bn-BD")).toBe("ltr"); expect(languageDirection("xx")).toBe("ltr");
});
it.each(LOCALES)("%s has exactly the en-US keys, all non-empty, same {{placeholders}}", (lang) => { /* compare key sets and placeholders per key */ });
```

- [ ] **Step 2:** `npx vitest run src/__tests__/i18n.test.ts` → FAIL. `i18n.ts` must not touch `localStorage`/`document` at import time without a `typeof window` guard, so the node test can import it.
- [ ] **Step 3:** Implement: registry + `languageDirection` + `applyLanguage`; replace the `loadPath` switch with a `Record<string, URL>` that includes `bn-BD` (each `new URL("./locales/base/<code>.json", import.meta.url)` written out literally so Vite resolves it); `LanguageSwitch` calls `applyLanguage` and drops its own dir effect; add the 20 new keys to all locales; `openapi.tsx` button text → `t("openapi-download")`.
- [ ] **Step 4:** Create `bn-BD.json` as a complete Bangla translation of all `en-US` keys (keep `{{placeholders}}`, HTML tags, brand names such as Bengal Exchange, Stripe, SSLCommerz, Amazon, Etsy, eBay untranslated). Work in key-prefix batches; validate JSON after each batch.
- [ ] **Step 5:** `npx vitest run` (all client tests) → PASS; `npm run type-check` → clean.

### Task 4: Navigation config (only existing destinations)

**Files:**
- Modify: `apps/client/src/config/site.ts`
- Test: `apps/client/src/__tests__/site-nav.test.ts`

**Interfaces:**
- Produces: `type NavLink = { key: string; href: string; external?: boolean }`; `PRIMARY_NAV: NavLink[]` = Shop `/`, Categories `/products`, Checkout `/cart`, Contact `/pages/contact` (Cart is rendered separately with its count); `MENU_INFO_LINKS` = About `/pages/about`, Blog `/pages/blog`, Contact `/pages/contact`; `FOOTER_COLUMNS: { titleKey: string; links: NavLink[] }[]` (Company, Help, Legal from today's footer); `SOCIAL_LINKS` (twitter, discord, github from `siteConfig().links`); `isKnownPath(href: string): boolean` (true for `/`, `/products`, `/cart`, `/account`, `/admin`, `/login`, and `/pages/<handle>` where `handle` is a key of `CMS_CONTENT`); `visibleLinks(links: NavLink[]): NavLink[]` (filters with `isKnownPath`, keeps external).

- [ ] **Step 1: Failing tests:** every link in `PRIMARY_NAV`, `MENU_INFO_LINKS`, `FOOTER_COLUMNS` passes `isKnownPath`; `isKnownPath("/pages/nope")` is false; `visibleLinks([{key:"x",href:"/pages/nope"}])` is `[]`; every `key` exists in `en-US.json`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement in `site.ts` (remove the old `navItems`/`navMenuItems` only after Tasks 5–6 stop using them). **Step 4:** Run → PASS.

### Task 5: Header + side menu

**Files:**
- Create: `apps/client/src/components/shell/site-header.tsx`, `apps/client/src/components/shell/side-menu.tsx`, `apps/client/src/components/shell/brand-mark.tsx`
- Modify: `apps/client/src/layouts/default.tsx`; delete `apps/client/src/components/navbar.tsx` once nothing imports it (grep first; `luxury.tsx` is already gone).

**Interfaces:**
- Consumes: `PRIMARY_NAV`, `MENU_INFO_LINKS` (Task 4); `useTheme()` (Task 1); `availableLanguages`, `applyLanguage` (Task 3); `useCart().count`, `useCartDrawer().open`, `useAuth()` (`isAuthenticated`, `user.is_admin`, `logout`), `LoginModal`.
- Produces: `<SiteHeader onOpenMenu={() => void} menuOpen={boolean} />`, `<SideMenu isOpen={boolean} onClose={() => void} />`, `<BrandMark />` (the mock's diamond SVG + "Bengal Exchange" wordmark, `font-display`).

- [ ] **Step 1:** `SiteHeader` per spec "Shared storefront shell": sticky, `bg-[color-mix(in_srgb,var(--bx-paper)_88%,transparent)] backdrop-blur border-b border-bx-line`, grid `1fr auto 1fr`, min-height 4.5rem (4rem ≤560px); centre nav from `PRIMARY_NAV` + Cart (opens drawer, `badge` with count, accent background) + search (pill input → `/?q=`; same behaviour as the old navbar); right: mobile cart button (≤960px) and the Menu pill (lines + "Menu" label hidden ≤560px + avatar), `aria-expanded`, `aria-controls="side-menu"`; ≤960px centre nav hidden and a full-width search row shown. Skip link "skip-to-content" targets `#main`.
- [ ] **Step 2:** `SideMenu`: HeroUI `Drawer` (or `Modal` placed right) 400px max, scrim `var(--bx-scrim)`; groups — (1) Profile `/account` (signed in), Admin dashboard `/admin` (`is_admin`), Log in (opens `LoginModal`) / Log out (`logout()`); (2) Language `<select>` of seven `nativeName`s → `applyLanguage`; Light/Dark segmented buttons (`aria-pressed`) → `setLightTheme`/`setDarkTheme`; (3) `MENU_INFO_LINKS`. Closes on Escape, scrim, link click and route change; focus returns to the Menu button.
- [ ] **Step 3:** `default.tsx`: render `SiteHeader`, `SideMenu`, `CartDrawer`, `<main id="main">` with `bx-wrap`, footer (Task 6). Remove social/translate/sun/Sponsor/⌘K header items (social moves to the footer).
- [ ] **Step 4:** `npm run type-check && npx vitest run` → clean. Playwright check (scratchpad script): open menu with Enter, Tab cycles inside, Escape closes, `document.activeElement` is the Menu button; switch to Dark from the menu → `<html>` has `.dark`; choose `ar-SA` → `dir="rtl"` after reload.

### Task 6: Footer

**Files:**
- Create: `apps/client/src/components/shell/site-footer.tsx`
- Modify: `apps/client/src/layouts/default.tsx`; delete `apps/client/src/components/footer.tsx` if unused (grep first).

**Interfaces:**
- Consumes: `FOOTER_COLUMNS`, `SOCIAL_LINKS`, `visibleLinks` (Task 4); `getPaymentMethods`, `enabledPaymentMethods` (`lib/store-api.ts`); `BrandMark` (Task 5); `LoginLogoutLink`, `UserTechnicalInfoModal` (kept from today's footer bottom bar).
- Produces: `<SiteFooter />`.

- [ ] **Step 1:** Mock footer: `bg-bx-surface border-t border-bx-line`; grid `1.6fr repeat(3,1fr)` (2 cols ≤960px, brand full width; 1 col ≤560px); brand + `footer-blurb`; **no newsletter**; columns via `visibleLinks`; bottom row: copyright · powered-by, social icon circles, payment badges = Visa, Mastercard, Stripe only when Stripe is enabled, SSLCommerz when it is enabled (fetch once; render nothing until loaded — fixed height row so no layout shift); "Manage the store"/user name on the right.
- [ ] **Step 2:** `npm run type-check && npx vitest run && npm run lint` → clean (no new warnings in touched files).

### Task 7: Phase 1 verification and hand-off

**Files:** scratchpad scripts only (`darkshots/shoot.mjs` extended); no source changes unless a check fails.

- [ ] **Step 1:** `npx vite build` → success; record the home entry chunk sizes (`dist/assets/*.js`, gzip) as the phase 1 baseline.
- [ ] **Step 2:** Screenshots, light and dark × 390 px and 1440 px: `/`, `/products`, product page, `/cart`, `/account` (test customer), `/pages/about`, plus the side menu open (phone + desktop), plus `ar-SA` and `bn-BD` home (phone). Each shot asserts `document.documentElement.scrollWidth <= innerWidth` and `.dark` matches the mode.
- [ ] **Step 3:** axe-core (inject `node_modules/axe-core/axe.min.js`) on `/` and with the side menu open, both modes → no `serious`/`critical` violations in header, menu or footer (page-body violations are listed for later phases, not fixed here).
- [ ] **Step 4:** LCP/CLS on `npx vite preview` with CDP throttling (4× CPU, Slow 4G) at 390 px → report LCP and CLS for `/` (targets: LCP < 2.5 s, CLS < 0.1; header must not shift).
- [ ] **Step 5:** Send the owner the screenshots (light/dark, phone/desktop), the axe and LCP/CLS results, the bundle baseline, and the list of page-body issues left for phase 2. Stop.
