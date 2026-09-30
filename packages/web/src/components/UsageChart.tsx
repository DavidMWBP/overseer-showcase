import { useState } from 'react';
import { fmtTokens, type Measure, type Stacks } from '../lib/usage';

/** Colour by series index, never cycled: past the sixth the series is already folded into "Other" (`SERIES_MAX`). */
export const seriesColor = (i: number): string => `var(--chart-${Math.min(i, 5) + 1})`;

const PLOT_H = 190;
const AXIS_H = 26;
// Room above the plot for the topmost tick label, which the viewport clipped when the plot started at y=0.
const PAD_T = 10;
const PAD_L = 52;
const GAP = 2; // the surface gap between stacked segments

/** A wider slot for a short range, so 7 days do not read as hairlines and 90 still fit a desktop card. */
export const slotFor = (days: number): number => (days <= 7 ? 56 : days <= 31 ? 26 : 11);

const fmtValue = (v: number, measure: Measure): string => (measure === 'tokens' ? fmtTokens(v) : `$${v.toFixed(2)}`);

/** A round-ish tick above the largest bar, so the axis reads in whole steps rather than in the data's own maximum. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (max <= step * pow) return step * pow;
  return 10 * pow;
}

/**
 * Cost or tokens per day, stacked by model. Hand-drawn SVG: the app carries no charting dependency, and the shapes here are
 * rectangles on a linear scale. The card scrolls sideways when the bars are wider than it, which is what a phone gets.
 */
export function UsageChart({ stacks, measure, label }: { stacks: Stacks; measure: Measure; label: string }) {
  // A day is shown either because the pointer is over it, or because it was tapped (`pinned`). A tap on a phone first fires a
  // synthesized mouse enter, so the pin survives that enter and the second tap on the same day closes the tooltip again.
  const [sel, setSel] = useState<{ i: number; pinned: boolean } | null>(null);
  const enter = (i: number) => setSel((s) => (s && s.pinned && s.i === i ? s : { i, pinned: false }));
  const toggle = (i: number) => setSel((s) => (s && s.pinned && s.i === i ? null : { i, pinned: true }));
  const slot = slotFor(stacks.days.length);
  const barW = Math.max(4, slot - 6);
  const width = PAD_L + stacks.days.length * slot + 12;
  const top = niceMax(stacks.max);
  const y = (v: number) => PAD_T + PLOT_H - (v / top) * PLOT_H;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  // Every fifth day on a long range, every day on a short one: a label per bar collides below ~26 px of slot.
  const labelEvery = slot >= 26 ? (stacks.days.length > 14 ? 5 : 1) : 10;
  const shown = sel === null ? null : stacks.days[sel.i];

  return (
    <div className="usage-chart">
      <div className="usage-chart-scroll">
        <svg width={width} height={PAD_T + PLOT_H + AXIS_H} role="img" aria-label={label} onMouseLeave={() => setSel((s) => (s && s.pinned ? s : null))}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="usage-grid" x1={PAD_L} x2={width - 12} y1={y(t)} y2={y(t)} />
              <text className="usage-tick" x={PAD_L - 8} y={y(t) + 4} textAnchor="end">{fmtValue(t, measure)}</text>
            </g>
          ))}
          {stacks.days.map((d, i) => {
            const x = PAD_L + i * slot + (slot - barW) / 2;
            // Stacked from the baseline up. Each segment but the last gives 2 px back to the surface, which is the spacer that
            // keeps two adjacent fills readable; the last keeps its full height and rounds its data-end.
            let base = PAD_T + PLOT_H;
            const bars = d.segments.map((s, si) => {
              const raw = (s.value / top) * PLOT_H;
              const last = si === d.segments.length - 1;
              const bar = { key: s.key, y: base - raw, h: Math.max(1, raw - (last ? 0 : GAP)), last };
              base -= raw;
              return bar;
            });
            return (
              <g key={d.day}>
                {bars.map((b) => <rect key={b.key} x={x} y={b.y} width={barW} height={b.h} rx={b.last ? 4 : 0} fill={seriesColor(stacks.series.indexOf(b.key))} />)}
                {/* One hit target per day, wider than the bar: hovering a thin bar on a 90-day range is otherwise a pixel hunt.
                    A click carries the same target on a phone, where there is no hover: it opens that day and closes it again. */}
                <rect
                  className="usage-hit"
                  x={PAD_L + i * slot}
                  y={PAD_T}
                  width={slot}
                  height={PLOT_H}
                  onMouseEnter={() => enter(i)}
                  onClick={() => toggle(i)}
                  data-day={d.day}
                />
                {i % labelEvery === 0 && <text className="usage-tick" x={PAD_L + i * slot + slot / 2} y={PAD_T + PLOT_H + 16} textAnchor="middle">{d.day.slice(5)}</text>}
              </g>
            );
          })}
          <line className="usage-axis" x1={PAD_L} x2={width - 12} y1={PAD_T + PLOT_H} y2={PAD_T + PLOT_H} />
        </svg>
      </div>
      {shown && (
        <div className="usage-tooltip" role="status">
          <strong>{shown.day}</strong>
          {shown.segments.length === 0
            ? <div className="muted">no sessions</div>
            : shown.segments.map((s) => (
              <div key={s.key} className="usage-tooltip-row">
                <span className="usage-swatch" style={{ background: seriesColor(stacks.series.indexOf(s.key)) }} aria-hidden="true" />
                <span className="usage-tooltip-name">{s.key}</span>
                <span className="mono">{fmtValue(s.value, measure)}</span>
              </div>
            ))}
          {shown.segments.length > 1 && <div className="usage-tooltip-row usage-tooltip-total"><span className="usage-tooltip-name">total</span><span className="mono">{fmtValue(shown.total, measure)}</span></div>}
        </div>
      )}
      <ul className="usage-legend">
        {stacks.series.map((s, i) => (
          <li key={s}><span className="usage-swatch" style={{ background: seriesColor(i) }} aria-hidden="true" />{s}</li>
        ))}
      </ul>
    </div>
  );
}
