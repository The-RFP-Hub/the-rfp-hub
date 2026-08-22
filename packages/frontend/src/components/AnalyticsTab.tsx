"use client";

/**
 * One entry's traffic: four counters, a chart per selected metric, and the days behind it.
 *
 * THE BEST-EFFORT LABEL IS PART OF THE FEATURE, not a disclaimer somebody can trim. These numbers
 * are API reads and link-outs rather than page views; the project's own exporter and compliance
 * checker are excluded by name, crawlers and `DNT: 1` are dropped, and capture is buffered in
 * memory and therefore lost if the service restarts mid-buffer. A publisher who reads them as
 * exact web analytics will draw wrong conclusions, so the surface says what they are.
 *
 * The click counters only move for link-outs that go through the API's redirect routes, which is
 * why every "open" control in this frontend points at `/v1/r/{id}/…` rather than at the stored
 * URL. Linking directly would leave `applyClicks` at zero forever and make this tab look broken.
 */
import { BarChart } from "@/components/BarChart";
import { UntrustedText } from "@/components/UntrustedText";
import { ResourceView } from "@/components/states";
import {
  type InsightsMetric,
  METRIC_LABELS,
  describeWindow,
  formatCount,
  formatDay,
  seriesFor,
} from "@/lib/format";
import { useResource } from "@/lib/resource";
import { useApi } from "@/lib/session";
import type { InsightsSeries } from "@/lib/types";
import { useCallback, useState } from "react";

const WINDOWS = [7, 30, 90] as const;
const METRICS: InsightsMetric[] = ["listViews", "detailViews", "sourceClicks", "applyClicks"];

export function AnalyticsTab({ opportunityId }: { opportunityId: string }) {
  const api = useApi();
  const [days, setDays] = useState<number>(30);
  const [metric, setMetric] = useState<InsightsMetric>("detailViews");

  const load = useCallback(
    () => api.insights.forOpportunity(opportunityId, days),
    [api, opportunityId, days],
  );
  const { state, reload } = useResource(load);

  return (
    <section aria-labelledby="analytics-heading">
      <div className="row-between">
        <h2 id="analytics-heading">Traffic</h2>
        <fieldset className="segmented">
          <legend className="visually-hidden">Window</legend>
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={days === option}
              onClick={() => setDays(option)}
            >
              {option} days
            </button>
          ))}
        </fieldset>
      </div>

      <ResourceView resource={state} what="this entry's traffic" onRetry={reload}>
        {(series) => (
          <SeriesView series={series} metric={metric} onMetric={setMetric} days={days} />
        )}
      </ResourceView>
    </section>
  );
}

/**
 * Split out from the fetching component so it can be rendered from a fixture in a test — which is
 * the whole point of the mandatory render test: proving that a series the API can actually return
 * turns into bars and numbers on a page, rather than proving the API returns one.
 */
export function SeriesView({
  series,
  metric,
  onMetric,
  days,
}: {
  series: InsightsSeries;
  metric: InsightsMetric;
  onMetric: (metric: InsightsMetric) => void;
  days: number;
}) {
  const points = seriesFor(series.days, metric);
  return (
    <>
      <p className="muted">
        <UntrustedText value={series.title} /> · {formatDay(series.from)} to {formatDay(series.to)}{" "}
        ({describeWindow(days)})
      </p>

      <ul className="tiles">
        {METRICS.map((key) => (
          <li key={key}>
            <button
              type="button"
              className="tile"
              aria-pressed={metric === key}
              onClick={() => onMetric(key)}
            >
              <span className="tile-value">{formatCount(series.totals[key])}</span>
              <span className="tile-label">{METRIC_LABELS[key]}</span>
            </button>
          </li>
        ))}
      </ul>

      <BarChart points={points} metricLabel={METRIC_LABELS[metric]} />

      <details>
        <summary>Day by day</summary>
        <table>
          <caption>{METRIC_LABELS[metric]} per day, UTC</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{METRIC_LABELS[metric]}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.day}>
                <th scope="row">{formatDay(point.day)}</th>
                <td>{formatCount(point.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <p className="muted footnote">
        Best-effort. These are API reads and link-outs, not page views: the project&rsquo;s own
        automation is excluded by name, crawlers and <code>DNT: 1</code> are dropped, and capture is
        buffered in memory, so a restart can lose the last couple of seconds. Days before today come
        from the nightly rollup; today is aggregated live.
      </p>
    </>
  );
}
