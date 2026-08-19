/**
 * A daily bar chart, hand-rolled as inline SVG.
 *
 * NO CHART LIBRARY, deliberately. The data is a gap-free list of daily integers — the API
 * zero-fills the whole window precisely so a consumer can map it straight onto bars — and the whole
 * job is one division and a rectangle per day. A charting dependency would add a few hundred
 * kilobytes to every page load, and most of them ship a runtime that wants `new Function` or
 * inline styles, which is a Content-Security-Policy argument this package should not have to have.
 *
 * ACCESSIBILITY IS NOT DECORATION HERE. A bar chart with no text is unreadable to a screen reader
 * and to anyone who wants the exact number, so every bar carries a `<title>` naming its day and
 * value, and the figure is followed by the same numbers as text. The chart is an illustration of a
 * table, not a replacement for one.
 */
import { type Bar, barGeometry, formatCount, formatDay } from "@/lib/format";

const WIDTH = 720;
const HEIGHT = 160;

export interface BarChartProps {
  points: readonly { day: string; value: number }[];
  /** What one bar counts — "Detail views". Used in the accessible name and the empty state. */
  metricLabel: string;
}

export function BarChart({ points, metricLabel }: BarChartProps) {
  if (points.length === 0) {
    return <p className="muted">No days in this window.</p>;
  }
  const { bars, max } = barGeometry(points, WIDTH, HEIGHT);
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const allZero = total === 0;

  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT + 4}`}
        className="chart-svg"
        role="img"
        aria-label={`${metricLabel} per day, ${points.length} days, peak ${formatCount(max)}`}
        preserveAspectRatio="none"
      >
        <title>{`${metricLabel} per day`}</title>
        {bars.map((bar: Bar) => (
          <g key={bar.label}>
            <rect
              x={bar.x}
              // A zero draws a 1px floor rather than nothing, so the window's shape stays legible
              // and an empty day is visibly an empty day rather than a hole in the axis.
              y={bar.value === 0 ? HEIGHT - 1 : bar.y}
              width={bar.width}
              height={bar.value === 0 ? 1 : bar.height}
              className={bar.value === 0 ? "bar bar-zero" : "bar"}
            >
              <title>{`${formatDay(bar.label)}: ${formatCount(bar.value)}`}</title>
            </rect>
          </g>
        ))}
      </svg>
      <div className="chart-axis">
        <span>{formatDay(points[0]?.day ?? "")}</span>
        <span className="muted">
          {allZero ? `No ${metricLabel.toLowerCase()} in this window` : `peak ${formatCount(max)}`}
        </span>
        <span>{formatDay(points[points.length - 1]?.day ?? "")}</span>
      </div>
    </figure>
  );
}
