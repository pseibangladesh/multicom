# Bengal Exchange redesign: decisions for the builder

**Date:** 2026-11-23 · **Spec:** `bengal-redesign-design.md` · **Mock:** `bengal-exchange-storefront-v2.html`

These decisions amend or clarify the spec. Where they conflict with the spec, this note wins.

## 1. Carousel ships now (amends spec decision 4 and the non-goals)

- Show the featured carousel in production, not only in dev.
- Add one optional label field to products: `offer`, `new_collection`, or `hot_pick`. Admins set it per product, and the carousel shows products that have a label.
- Keep the dev-only placeholder slides as fixtures. Do not show them in production.
- This is a small backend change. It is the only backend change in this redesign.
- Owner to confirm. If the owner prefers to wait for the backend, hide the section in production until the label field exists.

## 2. Load speed is a goal

Add these targets to the spec's goals. Check them in the production build on a mid-range phone profile.

- Largest Contentful Paint under 2.5 s on the home page.
- Cumulative Layout Shift under 0.1. The header, hero and carousel reserve their space before content loads.
- Product images use lazy loading and fixed aspect ratios.
- No blocking web fonts. Use the system serif and sans stacks.
- Shadows, gradients and heavy assets are not used for decoration.
- Bundle size for the home page is checked on each build, and any increase is reviewed.

## 3. Bangla font fallback

- Add Bangla fallbacks to the sans stack: "Noto Sans Bengali", "Kohinoor Bangla", "Nirmala UI", then the system sans.
- Use a Bangla-capable serif fallback for display text, or set display headings to the sans stack when `lang` is `bn-BD`.
- Test Bangla pages on an Android device and a Windows machine before sign-off.
- If Bangla rendering is still poor, self-host one Bangla font as a documented exception to the no-web-fonts rule.

## Also clarified

- Dark mode: the mock's `data-mode="dark"` maps to the `.dark` class on `<html>` and to `hooks/use-theme.ts`. Do not add a second theme switch.
- Env var: confirm whether the code reads `BENGAL_EXCHANGE_THEME` or `FUFUNI_THEME` before renaming anything.
- Admin dark mode: capture a baseline screenshot of the current admin in dark mode before admin work starts.
- Accessibility: visible focus, keyboard operation of the side menu and carousel, reduced-motion support, and contrast checks in both modes (for example axe in the Playwright run).
