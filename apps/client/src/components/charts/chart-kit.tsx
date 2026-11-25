/**
 * Shared pieces for the admin charts (Recharts): brand colours per mode,
 * a card frame with a data-table fallback, and a themed tooltip.
 *
 * Colours: Recharts writes SVG attributes, where CSS variables don't resolve,
 * so the hex values live here, picked by the current light/dark mode.
 * The categorical set (gold, blue, green) was checked with the dataviz
 * validator against each mode's card surface, all pairs (pie slices all touch):
 * lightness band, chroma, CVD and normal-vision separation, 3:1 contrast all
 * pass; CVD sits in the 6-8 band, so every pie also has slice gaps and a legend
 * with values. A fourth hue could not pass with gold, so slices past three fold
 * into a neutral "Other".
 */
import type { ReactNode } from "react";

import { useId } from "react";
import { useTranslation } from "react-i18next";

import { useTheme } from "@/hooks/use-theme";

export interface ChartColors {
  /** Single-series marks (bars, line): the brand gold. */
  primary: string;
  /** Up to three categories, in this fixed order. */
  categorical: [string, string, string];
  /** "Other" slice. */
  other: string;
  /** Card surface: slice gaps and marker rings. */
  surface: string;
  grid: string;
  axis: string;
  text: string;
}

const LIGHT: ChartColors = {
  primary: "#a87a1c",
  categorical: ["#a87a1c", "#2a6fd0", "#0f8a5f"],
  other: "#8c806b",
  surface: "#ffffff",
  grid: "#ece4d4",
  axis: "#6a604f",
  text: "#14110c",
};

const DARK: ChartColors = {
  primary: "#e2b45a",
  categorical: ["#b98a2a", "#5a83dc", "#199e70"],
  other: "#7d7262",
  surface: "#1c1915",
  grid: "#2e2a22",
  axis: "#a3988a",
  text: "#f4eee2",
};

export function useChartColors(): ChartColors {
  const { isDark } = useTheme();

  return isDark ? DARK : LIGHT;
}

/** Keeps the first three slices, folds the rest into one "Other" slice. */
export function foldSlices<T extends { value: number; label: string }>(
  slices: T[],
  otherLabel: string,
): { label: string; value: number }[] {
  const sorted = [...slices].sort((a, b) => b.value - a.value);

  if (sorted.length <= 3) return sorted;
  const rest = sorted.slice(3).reduce((s, x) => s + x.value, 0);

  return [...sorted.slice(0, 3), { label: otherLabel, value: rest }];
}

export interface ChartCardProps {
  title: string;
  subtitle?: string;
  /** Right side of the header, e.g. a period toggle. */
  actions?: ReactNode;
  /** Shown instead of the chart when there's nothing to plot. */
  empty?: boolean;
  emptyText?: string;
  /** Column headers and rows for the "Show data" table. */
  table: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  className?: string;
}

/** Card with title, the chart, and a collapsible data table (for screen readers too). */
export function ChartCard({
  title,
  subtitle,
  actions,
  empty,
  emptyText,
  table,
  children,
  className = "",
}: ChartCardProps) {
  const { t } = useTranslation();
  const id = useId();

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`bx-chart-card rounded-md border border-bx-line bg-bx-surface-raised p-4 md:p-5 ${className}`}
    >
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-bx-ink" id={`${id}-title`}>
            {title}
          </h2>
          {subtitle && <p className="text-xs text-bx-stone">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {empty ? (
        <p className="grid h-56 place-items-center text-sm text-bx-stone">
          {emptyText ?? t("admin-charts-empty")}
        </p>
      ) : (
        <>
          <div aria-hidden="true">{children}</div>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-xs text-bx-stone hover:text-bx-ink">
              {t("admin-charts-show-data")}
            </summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-bx-stone">
                    {table.columns.map((c) => (
                      <th key={c} className="py-1 pr-3 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, i) => (
                    <tr key={i} className="border-t border-bx-line">
                      {r.map((cell, j) => (
                        <td key={j} className="py-1 pr-3 tabular-nums">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/** Tooltip body in the theme's surface and ink (passed to Recharts `content`). */
export function ChartTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean;
  label?: ReactNode;
  rows: { name: string; value: string; color?: string }[];
}) {
  if (!active || rows.length === 0) return null;

  return (
    <div className="rounded-md border border-bx-line bg-bx-surface-raised px-3 py-2 text-xs text-bx-ink shadow-lg">
      {label != null && <p className="mb-1 font-semibold">{label}</p>}
      {rows.map((r) => (
        <p key={r.name} className="flex items-center gap-2">
          {r.color && (
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: r.color }}
            />
          )}
          <span className="text-bx-stone">{r.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">
            {r.value}
          </span>
        </p>
      ))}
    </div>
  );
}

/** Segmented period buttons (one row, fits a phone). */
export function PeriodToggle<P extends string>({
  periods,
  value,
  onChange,
}: {
  periods: readonly P[];
  value: P;
  onChange: (p: P) => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      aria-label={t("admin-analytics-period-label")}
      className="inline-flex shrink-0 rounded-md border border-bx-line bg-bx-surface p-0.5"
      role="group"
    >
      {periods.map((p) => (
        <button
          key={p}
          aria-pressed={value === p}
          className={`bx-tap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === p
              ? "bg-bx-primary text-bx-on-primary"
              : "text-bx-stone hover:text-bx-ink"
          }`}
          type="button"
          onClick={() => onChange(p)}
        >
          {t(`admin-analytics-period-${p}`)}
        </button>
      ))}
    </div>
  );
}
