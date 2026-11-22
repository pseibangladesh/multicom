/**
 * Copyright (c) 2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * Line icons from the Bengal mock (24px grid, currentColor).
 */

import type { ReactNode } from "react";

function Icon({ children, sw = 1.8 }: { children: ReactNode; sw?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="bx-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export const SearchGlyph = () => (
  <Icon sw={2}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const CartGlyph = () => (
  <Icon>
    <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2" />
    <circle cx="9.5" cy="19.5" r="1.3" />
    <circle cx="17" cy="19.5" r="1.3" />
  </Icon>
);
export const PersonGlyph = () => (
  <Icon>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Icon>
);
export const CloseGlyph = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const LoginGlyph = () => (
  <Icon>
    <path d="M15 4h4v16h-4M10 16l4-4-4-4M14 12H3" />
  </Icon>
);
export const GlobeGlyph = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
);
export const MoonGlyph = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
  </Icon>
);
export const InfoGlyph = () => (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Icon>
);
export const BlogGlyph = () => (
  <Icon>
    <path d="M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4" />
  </Icon>
);
export const MailGlyph = () => (
  <Icon>
    <path d="M4 6h16v12H4zM4 7l8 6 8-6" />
  </Icon>
);
export const ShieldGlyph = () => (
  <Icon>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" />
  </Icon>
);
