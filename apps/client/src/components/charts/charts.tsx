/**
 * The admin charts. Each is a single series in the brand gold, except the
 * donut (up to three categorical hues + "Other"). Specs: thin marks, 4px
 * rounded bar ends on the baseline, 2px lines, recessive grid and axes,
 * hover tooltips, and a data table in the card (components/charts/chart-kit).
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartTooltip, useChartColors } from "./chart-kit";

export interface TimeDatum {
  /** Short axis label, e.g. "Nov 21". */
  label: string;
  value: number;
}

const AXIS_TICK = { fontSize: 11 };

/** Vertical bars over time (e.g. orders per day). */
export function TimeBarChart({
  data,
  seriesName,
  format = (v) => String(v),
  height = 240,
}: {
  data: TimeDatum[];
  seriesName: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const c = useChartColors();
  // Many days: thinner bars and fewer ticks so labels never collide.
  const tickGap = data.length > 14 ? 24 : 8;

  return (
    <ResponsiveContainer height={height} width="100%">
      <BarChart
        barCategoryGap={data.length > 14 ? 2 : "25%"}
        data={data}
        margin={{ top: 8, right: 4, bottom: 0, left: -12 }}
      >
        <CartesianGrid stroke={c.grid} strokeDasharray="0" vertical={false} />
        <XAxis
          axisLine={{ stroke: c.grid }}
          dataKey="label"
          minTickGap={tickGap}
          tick={{ ...AXIS_TICK, fill: c.axis }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          axisLine={false}
          tick={{ ...AXIS_TICK, fill: c.axis }}
          tickFormatter={(v: number) => format(v)}
          tickLine={false}
          width={56}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              label={label}
              rows={
                payload?.length
                  ? [
                      {
                        name: seriesName,
                        value: format(Number(payload[0].value)),
                        color: c.primary,
                      },
                    ]
                  : []
              }
            />
          )}
          cursor={{ fill: c.grid, opacity: 0.6 }}
        />
        <Bar
          dataKey="value"
          fill={c.primary}
          isAnimationActive={false}
          maxBarSize={36}
          name={seriesName}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** A line over time with a faint fill under it (e.g. revenue per day). */
export function TimeLineChart({
  data,
  seriesName,
  format = (v) => String(v),
  height = 260,
}: {
  data: TimeDatum[];
  seriesName: string;
  format?: (v: number) => string;
  height?: number;
}) {
  const c = useChartColors();
  const gradientId = "bx-line-fill";

  return (
    <ResponsiveContainer height={height} width="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={c.primary} stopOpacity={0.28} />
            <stop offset="100%" stopColor={c.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={c.grid} vertical={false} />
        <XAxis
          axisLine={{ stroke: c.grid }}
          dataKey="label"
          minTickGap={24}
          tick={{ ...AXIS_TICK, fill: c.axis }}
          tickLine={false}
        />
        <YAxis
          axisLine={false}
          tick={{ ...AXIS_TICK, fill: c.axis }}
          tickFormatter={(v: number) => format(v)}
          tickLine={false}
          width={72}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              label={label}
              rows={
                payload?.length
                  ? [
                      {
                        name: seriesName,
                        value: format(Number(payload[0].value)),
                        color: c.primary,
                      },
                    ]
                  : []
              }
            />
          )}
          cursor={{ stroke: c.axis, strokeDasharray: "3 3" }}
        />
        <Area
          activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2 }}
          dataKey="value"
          dot={false}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
          name={seriesName}
          stroke={c.primary}
          strokeWidth={2}
          type="monotone"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Ranked horizontal bars, largest first (e.g. top products). */
export function RankedBarChart({
  data,
  seriesName,
  format = (v) => String(v),
}: {
  data: { label: string; value: number }[];
  seriesName: string;
  format?: (v: number) => string;
}) {
  const c = useChartColors();
  const height = Math.max(160, data.length * 34 + 24);

  return (
    <ResponsiveContainer height={height} width="100%">
      <BarChart
        barCategoryGap={6}
        data={data}
        layout="vertical"
        margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
      >
        <CartesianGrid horizontal={false} stroke={c.grid} />
        <XAxis
          axisLine={false}
          tick={{ ...AXIS_TICK, fill: c.axis }}
          tickFormatter={(v: number) => format(v)}
          tickLine={false}
          type="number"
        />
        <YAxis
          axisLine={{ stroke: c.grid }}
          dataKey="label"
          interval={0}
          tick={{ ...AXIS_TICK, fill: c.text }}
          tickFormatter={(v: string) =>
            v.length > 22 ? `${v.slice(0, 21)}…` : v
          }
          tickLine={false}
          type="category"
          width={150}
        />
        <Tooltip
          content={({ active, payload, label }) => (
            <ChartTooltip
              active={active}
              label={label}
              rows={
                payload?.length
                  ? [
                      {
                        name: seriesName,
                        value: format(Number(payload[0].value)),
                        color: c.primary,
                      },
                    ]
                  : []
              }
            />
          )}
          cursor={{ fill: c.grid, opacity: 0.6 }}
        />
        <Bar
          dataKey="value"
          fill={c.primary}
          isAnimationActive={false}
          maxBarSize={22}
          name={seriesName}
          radius={[0, 4, 4, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Donut for a part-to-whole split, with a legend list that carries each
 * slice's name, value and share (so identity never rests on colour alone).
 * Pass at most four slices (three + "Other", see foldSlices).
 */
export function ShareDonut({
  data,
  format = (v) => String(v),
}: {
  data: { label: string; value: number }[];
  format?: (v: number) => string;
}) {
  const c = useChartColors();
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const colorAt = (i: number) => (i < 3 ? c.categorical[i] : c.other);

  return (
    // Legend beside the donut only when the card itself is wide enough
    // (a container query, so it also works in narrow grid columns).
    <div className="@container">
      <div className="flex flex-col items-center gap-4 @sm:flex-row">
        <div className="h-48 w-48 shrink-0">
          <ResponsiveContainer height="100%" width="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                innerRadius="58%"
                isAnimationActive={false}
                nameKey="label"
                outerRadius="100%"
                paddingAngle={0}
                // Surface-coloured gaps between slices; a lone slice has
                // no neighbour, and its stroke would draw a seam.
                stroke={data.length > 1 ? c.surface : "none"}
                strokeWidth={2}
              >
                {data.map((d, i) => (
                  <Cell key={d.label} fill={colorAt(i)} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }) => {
                  const p = payload?.[0];

                  return (
                    <ChartTooltip
                      active={active}
                      rows={
                        p
                          ? [
                              {
                                name: String(p.name),
                                value: `${format(Number(p.value))} · ${Math.round((Number(p.value) / total) * 100)}%`,
                                color: colorAt(
                                  data.findIndex((d) => d.label === p.name),
                                ),
                              },
                            ]
                          : []
                      }
                    />
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-2 text-sm">
          {data.map((d, i) => (
            <li key={d.label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ background: colorAt(i) }}
              />
              <span className="min-w-0 flex-1 truncate text-bx-ink">
                {d.label}
              </span>
              <span className="tabular-nums text-bx-ink">
                {format(d.value)}
              </span>
              <span className="w-10 text-right tabular-nums text-bx-stone">
                {Math.round((d.value / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
