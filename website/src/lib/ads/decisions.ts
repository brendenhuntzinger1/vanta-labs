/**
 * The decision engine — which creatives are winning, which are losing, and why.
 *
 * Two commitments shape every function here.
 *
 * **Metrics are judged on their own denominators.** An ad is impressions, then
 * clicks, then carts, then purchases. A decided CTR says nothing about
 * conversion. Every verdict therefore carries the list of metrics that remain
 * unresolved, and no recommendation is allowed to rest on a metric that was
 * never decided.
 *
 * **Creative problems and funnel problems are separated before anything is
 * prescribed.** They look identical in a ROAS number and have opposite fixes;
 * replacing creative when the landing page is the issue burns budget and
 * teaches nothing. The engine would rather say "this is not a creative problem"
 * than produce a confident wrong answer.
 */

import type { DerivedMetrics, PerformanceSnapshot, Decision, DecisionAction } from "./types";
import { BLIND_SPOTS, testAgainstBenchmark, type BenchmarkResult, type Options } from "./stats";

/** Sum a set of daily snapshots for one creative into a single window. */
export function aggregate(snapshots: PerformanceSnapshot[]): PerformanceSnapshot | null {
  if (snapshots.length === 0) return null;
  const first = snapshots[0];
  const sum = (pick: (s: PerformanceSnapshot) => number | null | undefined) =>
    snapshots.reduce((total, s) => total + (pick(s) ?? 0), 0);

  return {
    ...first,
    snapshotId: `agg-${first.creativeId}`,
    statDate: `${snapshots[0].statDate}..${snapshots[snapshots.length - 1].statDate}`,
    spend: sum((s) => s.spend),
    impressions: sum((s) => s.impressions),
    clicks: sum((s) => s.clicks),
    reach: sum((s) => s.reach),
    videoViews: sum((s) => s.videoViews),
    views2s: sum((s) => s.views2s),
    views6s: sum((s) => s.views6s),
    viewsComplete: sum((s) => s.viewsComplete),
    platformConversions: sum((s) => s.platformConversions),
    siteSessions: sum((s) => s.siteSessions),
    siteAddToCarts: sum((s) => s.siteAddToCarts),
    siteCheckouts: sum((s) => s.siteCheckouts),
    sitePurchases: sum((s) => s.sitePurchases),
    siteRevenue: sum((s) => s.siteRevenue),
    siteRefunds: sum((s) => s.siteRefunds),
  };
}

const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * Derived metrics are computed, never stored, so they cannot drift from the
 * counts that produced them. Revenue net of refunds — an ad that generated a
 * sale that came back did not generate a sale.
 */
export function derive(s: PerformanceSnapshot): DerivedMetrics {
  const netRevenue = s.siteRevenue - s.siteRefunds;
  return {
    ctr: rate(s.clicks, s.impressions),
    cpc: s.clicks > 0 ? s.spend / s.clicks : null,
    cpm: s.impressions > 0 ? (s.spend / s.impressions) * 1000 : null,
    atcRate: rate(s.siteAddToCarts, s.clicks),
    checkoutRate: rate(s.siteCheckouts, s.siteAddToCarts),
    cvr: rate(s.sitePurchases, s.clicks),
    cpa: s.sitePurchases > 0 ? s.spend / s.sitePurchases : null,
    roas: s.spend > 0 ? netRevenue / s.spend : null,
    hookRate: rate(s.views2s ?? 0, s.impressions),
    holdRate: rate(s.views6s ?? 0, s.views2s ?? 0),
  };
}

export type Benchmarks = {
  /** Account trailing rates. Must predate the window under test. */
  ctr: { value: number; source: string };
  atcRate: { value: number; source: string };
  cvr: { value: number; source: string };
  targetCpa: number;
  targetRoas: number;
};

export type MetricVerdicts = {
  ctr: BenchmarkResult | null;
  atcRate: BenchmarkResult | null;
  cvr: BenchmarkResult | null;
};

/**
 * Test each rate metric against its own benchmark on its own denominator.
 *
 * CPA and ROAS are absent on purpose: they are ratios of money, not
 * proportions, and running them through a binomial test produces a confident
 * number that means nothing. They are judged on conversion counts instead.
 */
export function judgeMetrics(s: PerformanceSnapshot, benchmarks: Benchmarks, options: Options = {}): MetricVerdicts {
  const safe = (fn: () => BenchmarkResult): BenchmarkResult | null => {
    try {
      return fn();
    } catch {
      // A metric with no denominator yet is not an error, it is an unanswered
      // question — and the caller already treats null as unresolved.
      return null;
    }
  };
  return {
    ctr: safe(() => testAgainstBenchmark("ctr", s.clicks, s.impressions, benchmarks.ctr.value, benchmarks.ctr.source, options)),
    atcRate: safe(() =>
      testAgainstBenchmark("atc_rate", s.siteAddToCarts, s.clicks, benchmarks.atcRate.value, benchmarks.atcRate.source, options),
    ),
    cvr: safe(() =>
      testAgainstBenchmark("cvr", s.sitePurchases, s.clicks, benchmarks.cvr.value, benchmarks.cvr.source, options),
    ),
  };
}

const decided = (r: BenchmarkResult | null): boolean => !!r && r.verdict !== "UNRESOLVED";
const worse = (r: BenchmarkResult | null): boolean => r?.verdict === "DECISIVE_WORSE";
const better = (r: BenchmarkResult | null): boolean => r?.verdict === "DECISIVE_BETTER";

export type DecisionInput = {
  creativeId: string;
  snapshot: PerformanceSnapshot;
  benchmarks: Benchmarks;
  /** Days the creative has been running. Gates scaling. */
  daysRunning: number;
  minConversionsToScale: number;
  minDaysToScale: number;
  options?: Options;
  now: string;
};

/**
 * Produce one recommendation for one creative.
 *
 * Ordering matters and is deliberate: funnel problems are identified before
 * creative problems, because the expensive mistake is rebuilding an ad that was
 * working. Scaling is checked last and gated hardest, since it is the only
 * outcome that increases spend.
 */
export function decide(input: DecisionInput): Decision {
  const { snapshot, benchmarks, now } = input;
  const m = derive(snapshot);
  const verdicts = judgeMetrics(snapshot, benchmarks, input.options);

  const decidedMetrics: string[] = [];
  const unresolvedMetrics: string[] = [];
  for (const [name, verdict] of Object.entries(verdicts)) {
    (decided(verdict) ? decidedMetrics : unresolvedMetrics).push(name);
  }

  let action: DecisionAction = "keep_running";
  let rationale: string;

  if (decidedMetrics.length === 0) {
    action = "keep_running";
    rationale =
      `Nothing is decided yet on ${input.creativeId}. ` +
      unresolvedMetrics.map((n) => `${n}: ${verdicts[n as keyof MetricVerdicts]?.unresolvedBecause[0] ?? "no data"}`).join("; ") +
      ". Let it run rather than manufacturing a verdict from a thin sample.";
  } else if (worse(verdicts.ctr)) {
    // A decisively weak hook is actionable on its own, and says nothing about
    // anything downstream — which the rationale states rather than implies.
    action = "retire_hook";
    rationale =
      `${input.creativeId}: CTR is decisively below benchmark (${verdicts.ctr!.reads}). The hook is the problem. ` +
      `Everything downstream — ${unresolvedMetrics.join(", ") || "conversion and CPA"} — remains UNRESOLVED and is not evidence for or against this ad.`;
  } else if (better(verdicts.ctr) && worse(verdicts.atcRate)) {
    action = "investigate_funnel";
    rationale =
      `${input.creativeId}: the ad is working and the page is not. CTR beats benchmark while add-to-cart rate is ` +
      `decisively below it (${verdicts.atcRate!.reads}). This is not a creative problem — do not rebuild the ad.`;
  } else if (decided(verdicts.atcRate) && !worse(verdicts.atcRate) && worse(verdicts.cvr)) {
    action = "investigate_funnel";
    rationale =
      `${input.creativeId}: carts are forming and purchases are not (${verdicts.cvr!.reads}). That is checkout or offer friction, not creative.`;
  } else if (better(verdicts.ctr) || better(verdicts.cvr)) {
    const conversions = snapshot.sitePurchases;
    const roasOk = m.roas !== null && m.roas >= benchmarks.targetRoas;
    if (conversions >= input.minConversionsToScale && input.daysRunning >= input.minDaysToScale && roasOk) {
      action = "scale_budget";
      rationale =
        `${input.creativeId}: beats benchmark with ${conversions} conversions over ${input.daysRunning} days and ROAS ` +
        `${m.roas!.toFixed(2)} against a ${benchmarks.targetRoas.toFixed(2)} target. Recommend a step increase, then re-measure.`;
    } else {
      action = "produce_variants";
      const shortfall: string[] = [];
      if (conversions < input.minConversionsToScale) shortfall.push(`${conversions}/${input.minConversionsToScale} conversions`);
      if (input.daysRunning < input.minDaysToScale) shortfall.push(`${input.daysRunning}/${input.minDaysToScale} days`);
      if (!roasOk) shortfall.push(`ROAS ${m.roas === null ? "unknown" : m.roas.toFixed(2)} below the ${benchmarks.targetRoas.toFixed(2)} target`);
      rationale =
        `${input.creativeId} is outperforming but not yet safe to scale (${shortfall.join(", ")}). ` +
        `Iterate the variable, not the concept: same body, new hooks.`;
    }
  } else {
    action = "keep_running";
    rationale = `${input.creativeId}: decided metrics are at benchmark. No change warranted.`;
  }

  return {
    decisionId: `dec-${input.creativeId}-${now}`,
    creativeId: input.creativeId,
    action,
    rationale,
    decidedMetrics,
    unresolvedMetrics,
    evidence: {
      derived: m,
      verdicts,
      blindSpots: decidedMetrics.flatMap((name) => BLIND_SPOTS[name === "atcRate" ? "atc_rate" : name] ?? []),
      daysRunning: input.daysRunning,
    },
    // Always false here. Whether an action may execute is the guardrail
    // layer's decision, not the analyst's, and keeping that boundary sharp is
    // what stops a persuasive rationale from becoming permission to spend.
    autoExecutable: false,
    createdAt: now,
  };
}

/**
 * Which patterns and hooks are actually working, across creatives.
 *
 * Aggregating by attribute is how the system learns something reusable rather
 * than a list of individual winners. Reported with counts so a "winning"
 * pattern seen twice is visibly weaker evidence than one seen thirty times.
 */
export function rankByAttribute(
  rows: { creativeId: string; attribute: string; snapshot: PerformanceSnapshot }[],
): { attribute: string; creatives: number; spend: number; purchases: number; revenue: number; roas: number | null; cpa: number | null }[] {
  const buckets = new Map<string, { creatives: Set<string>; spend: number; purchases: number; revenue: number }>();
  for (const row of rows) {
    const bucket = buckets.get(row.attribute) ?? { creatives: new Set<string>(), spend: 0, purchases: 0, revenue: 0 };
    bucket.creatives.add(row.creativeId);
    bucket.spend += row.snapshot.spend;
    bucket.purchases += row.snapshot.sitePurchases;
    bucket.revenue += row.snapshot.siteRevenue - row.snapshot.siteRefunds;
    buckets.set(row.attribute, bucket);
  }
  return [...buckets.entries()]
    .map(([attribute, b]) => ({
      attribute,
      creatives: b.creatives.size,
      spend: b.spend,
      purchases: b.purchases,
      revenue: b.revenue,
      roas: b.spend > 0 ? b.revenue / b.spend : null,
      cpa: b.purchases > 0 ? b.spend / b.purchases : null,
    }))
    .sort((a, b) => (b.roas ?? -1) - (a.roas ?? -1));
}
