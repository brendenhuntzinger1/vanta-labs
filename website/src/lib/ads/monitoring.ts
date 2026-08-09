/**
 * Fatigue and anomaly detection — change over time, not a fixed line.
 *
 * A threshold like "CTR below 1% is bad" is wrong for two reasons. It ignores
 * what this account's normal actually is, and it cannot tell a creative that
 * was always mediocre from one that was excellent last week and is collapsing
 * now. The second is the one that costs money, and only a time series can see
 * it.
 *
 * So everything here compares a creative to **its own history** and to the
 * account's own baseline, and every finding carries whether the sample can
 * support the claim. A confident fatigue alert on three days of data is a
 * recommendation to waste money.
 */

import { compareCreatives, type Verdict } from "./stats";

export type DailyPoint = {
  statDate: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
};

// ---------------------------------------------------------------------------
// Fatigue
// ---------------------------------------------------------------------------

export type FatigueState = "insufficient_data" | "healthy" | "softening" | "fatigued";

export type FatigueAssessment = {
  creativeId: string;
  state: FatigueState;
  /** Peak CTR over a rolling window, and when it happened. */
  peakCtr: number | null;
  peakWindowEnd: string | null;
  recentCtr: number | null;
  /** Relative decline from peak. 0.3 = CTR is 30% below its best. */
  declineFromPeak: number | null;
  /** Whether the decline is bigger than noise, tested not eyeballed. */
  statisticalVerdict: Verdict | null;
  daysObserved: number;
  /** Frequency-driven fatigue looks different from creative wear-out. */
  spendStable: boolean;
  reasoning: string;
  recommendation: string;
};

/** Rolling windows rather than single days — one bad Tuesday is not fatigue. */
export const FATIGUE_WINDOW_DAYS = 3;
export const MIN_DAYS_FOR_FATIGUE = 7;
export const SOFTENING_DECLINE = 0.2;
export const FATIGUED_DECLINE = 0.3;

function windowSum(points: DailyPoint[]): { impressions: number; clicks: number; spend: number } {
  return points.reduce(
    (acc, p) => ({ impressions: acc.impressions + p.impressions, clicks: acc.clicks + p.clicks, spend: acc.spend + p.spend }),
    { impressions: 0, clicks: 0, spend: 0 },
  );
}

/**
 * Detect wear-out by comparing a creative's recent window against its own peak.
 *
 * Uses the peak rather than the start because creatives frequently improve
 * during learning before declining; measuring from day one would call that
 * whole arc healthy and miss the turn.
 *
 * The decline is then tested statistically, so a 35% drop on 400 impressions
 * does not produce the same alert as a 35% drop on 40,000.
 */
export function assessFatigue(creativeId: string, series: DailyPoint[]): FatigueAssessment {
  const points = [...series].sort((a, b) => a.statDate.localeCompare(b.statDate));

  if (points.length < MIN_DAYS_FOR_FATIGUE) {
    return {
      creativeId, state: "insufficient_data",
      peakCtr: null, peakWindowEnd: null, recentCtr: null, declineFromPeak: null,
      statisticalVerdict: null, daysObserved: points.length, spendStable: false,
      reasoning: `Only ${points.length} day(s) of data. Fatigue is a shape over time and cannot be read from this.`,
      recommendation: "Keep running. Re-assess once there are at least a week of days.",
    };
  }

  const windows: { end: string; impressions: number; clicks: number; spend: number }[] = [];
  for (let i = FATIGUE_WINDOW_DAYS - 1; i < points.length; i++) {
    const slice = points.slice(i - FATIGUE_WINDOW_DAYS + 1, i + 1);
    windows.push({ end: points[i].statDate, ...windowSum(slice) });
  }

  const withCtr = windows
    .filter((w) => w.impressions > 0)
    .map((w) => ({ ...w, ctr: w.clicks / w.impressions }));

  if (withCtr.length < 2) {
    return {
      creativeId, state: "insufficient_data",
      peakCtr: null, peakWindowEnd: null, recentCtr: null, declineFromPeak: null,
      statisticalVerdict: null, daysObserved: points.length, spendStable: false,
      reasoning: "Not enough windows with impressions to compare.",
      recommendation: "Keep running.",
    };
  }

  const recent = withCtr[withCtr.length - 1];
  // Peak must come BEFORE the recent window, or a creative at its best would be
  // compared against itself and always look healthy.
  const earlier = withCtr.slice(0, -1);
  const peak = earlier.reduce((best, w) => (w.ctr > best.ctr ? w : best), earlier[0]);

  const declineFromPeak = peak.ctr > 0 ? (peak.ctr - recent.ctr) / peak.ctr : 0;

  // Spend stability separates creative wear-out from a budget change. A CTR
  // drop while spend tripled is an auction/reach story, not a tired creative.
  const spendRatio = peak.spend > 0 ? recent.spend / peak.spend : 1;
  const spendStable = spendRatio >= 0.7 && spendRatio <= 1.4;

  const comparison = compareCreatives(
    "ctr",
    { successes: recent.clicks, trials: recent.impressions },
    { successes: peak.clicks, trials: peak.impressions },
  );
  const decisive = comparison.verdict === "DECISIVE_DIFFERENCE";

  let state: FatigueState;
  let reasoning: string;
  let recommendation: string;

  if (declineFromPeak >= FATIGUED_DECLINE && decisive) {
    state = "fatigued";
    reasoning =
      `CTR is ${(declineFromPeak * 100).toFixed(0)}% below its own peak (${(peak.ctr * 100).toFixed(2)}% ` +
      `around ${peak.end}, now ${(recent.ctr * 100).toFixed(2)}%), and the drop is larger than sampling noise. ` +
      (spendStable
        ? "Spend is roughly flat, so this is creative wear-out rather than a reach effect."
        : `Spend also moved ${spendRatio > 1 ? "up" : "down"} ${Math.abs((spendRatio - 1) * 100).toFixed(0)}%, ` +
          "so some of this may be auction rather than the creative itself.");
    recommendation = "Recommend rotating this creative. Keep the audience and the concept; change the execution.";
  } else if (declineFromPeak >= SOFTENING_DECLINE) {
    state = "softening";
    reasoning =
      `CTR is ${(declineFromPeak * 100).toFixed(0)}% off peak but the drop is ` +
      `${decisive ? "material yet under the rotation threshold" : "not yet distinguishable from noise"}.`;
    recommendation = "Watch. Prepare a replacement now so rotation is not rushed later.";
  } else {
    state = "healthy";
    reasoning = `CTR is within ${(Math.abs(declineFromPeak) * 100).toFixed(0)}% of its peak. No wear-out signal.`;
    recommendation = "No action.";
  }

  return {
    creativeId, state,
    peakCtr: peak.ctr, peakWindowEnd: peak.end, recentCtr: recent.ctr,
    declineFromPeak, statisticalVerdict: comparison.verdict,
    daysObserved: points.length, spendStable, reasoning, recommendation,
  };
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

export type AnomalyKind =
  | "traffic_collapse"
  | "traffic_spike"
  | "conversion_collapse"
  | "event_flow_break"
  | "spend_spike"
  | "cost_spike";

export type Anomaly = {
  kind: AnomalyKind;
  metric: string;
  observed: number;
  expected: number;
  /** Standard deviations from the trailing mean. */
  zScore: number;
  severity: "watch" | "urgent";
  reasoning: string;
  /** What to check first. An alert without a next step is just anxiety. */
  investigate: string;
};

function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(1, values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export const MIN_BASELINE_DAYS = 7;
export const ANOMALY_Z = 3;

/**
 * Flag today against the trailing distribution.
 *
 * Deliberately conservative at z=3. Marketing data is noisy and weekly-seasonal;
 * a looser bar produces daily alerts, and an operator who learns to dismiss
 * alerts has no alerting at all.
 *
 * A zero-variance baseline is treated as no baseline rather than as infinite
 * confidence — seven identical days usually means a stuck feed, and dividing by
 * a zero standard deviation would turn that into a spectacular false alarm.
 */
export function detectAnomalies(series: DailyPoint[], today: DailyPoint): Anomaly[] {
  const baseline = [...series]
    .sort((a, b) => a.statDate.localeCompare(b.statDate))
    .filter((p) => p.statDate < today.statDate)
    .slice(-28);

  if (baseline.length < MIN_BASELINE_DAYS) return [];

  const anomalies: Anomaly[] = [];
  const check = (
    kind: AnomalyKind,
    metric: string,
    values: number[],
    observed: number,
    direction: "drop" | "rise",
    investigate: string,
  ) => {
    const { mean, std } = meanStd(values);
    if (std === 0 || mean === 0) return;
    const z = (observed - mean) / std;
    const triggered = direction === "drop" ? z <= -ANOMALY_Z : z >= ANOMALY_Z;
    if (!triggered) return;
    anomalies.push({
      kind, metric, observed, expected: Math.round(mean * 100) / 100, zScore: Math.round(z * 100) / 100,
      severity: Math.abs(z) >= 5 ? "urgent" : "watch",
      reasoning:
        `${metric} is ${observed} against a trailing average of ${mean.toFixed(1)} ` +
        `(${Math.abs(z).toFixed(1)} standard deviations ${direction === "drop" ? "below" : "above"} normal).`,
      investigate,
    });
  };

  check("traffic_collapse", "impressions", baseline.map((p) => p.impressions), today.impressions, "drop",
    "Check the campaign is still active and not budget-capped or in review.");
  check("traffic_spike", "impressions", baseline.map((p) => p.impressions), today.impressions, "rise",
    "Check whether a budget or bid changed. Sudden reach often costs efficiency.");
  check("spend_spike", "spend", baseline.map((p) => p.spend), today.spend, "rise",
    "Confirm no budget was raised unintentionally. Compare against the daily ceiling.");
  check("conversion_collapse", "conversions", baseline.map((p) => p.conversions), today.conversions, "drop",
    "Check the pixel is firing and checkout is working before blaming the creative.");

  // Event-flow break: clicks arriving with no site sessions behind them is a
  // tracking failure, not a performance change, and must never be read as one.
  if (today.clicks >= 25 && today.conversions === 0) {
    const converting = baseline.filter((p) => p.conversions > 0).length;
    if (converting >= Math.ceil(baseline.length * 0.6)) {
      anomalies.push({
        kind: "event_flow_break", metric: "conversions", observed: 0,
        expected: Math.round((baseline.reduce((a, p) => a + p.conversions, 0) / baseline.length) * 100) / 100,
        zScore: 0, severity: "urgent",
        reasoning:
          `${today.clicks} clicks produced zero conversions on a day where ${converting} of the last ` +
          `${baseline.length} days converted. That pattern is usually measurement, not demand.`,
        investigate: "Check the pixel, the consent banner, and that utm_content still reaches the order.",
      });
    }
  }

  const cpcBaseline = baseline.filter((p) => p.clicks > 0).map((p) => p.spend / p.clicks);
  if (today.clicks > 0 && cpcBaseline.length >= MIN_BASELINE_DAYS) {
    check("cost_spike", "CPC", cpcBaseline, Math.round((today.spend / today.clicks) * 100) / 100, "rise",
      "Auction pressure or a targeting change. Not a creative problem on its own.");
  }

  return anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
}
