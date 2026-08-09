/**
 * Per-metric statistical decisions for ad spend.
 *
 * This is a deliberate port of `.claude/skills/vanta-creative-director/scripts/
 * decisive.py`. Two implementations of the same maths is a drift hazard, so
 * `stats.parity.test.ts` runs both over a grid and fails if they ever disagree.
 * The Python one is what a session reasons with; this one is what the runtime
 * decides with. They must stay the same function.
 *
 * The core idea: an ad is not one sample. It is impressions, then clicks, then
 * carts, then purchases — each denominator smaller than the last. At 1,900
 * impressions and 13 clicks the click-through rate can be decisively broken
 * while the conversion rate is genuinely unknowable, on the same ad, in the
 * same minute. One "minimum sample" rule for the whole ad gets one of them
 * wrong whichever number you pick.
 */

export const BASE_ALPHA = 0.05;
/**
 * Below this relative gap a difference can be perfectly real and still not
 * worth a decision. 20% is the smallest move that survives auction noise.
 */
export const DEFAULT_MIN_EFFECT = 0.2;
/** np >= 5 — below it a score interval is arithmetic, not evidence. */
export const MIN_EXPECTED_EVENTS = 5;
export const MIN_OBSERVED_FOR_BETTER = 5;
/** A head-to-head has no benchmark, so the floor sits on the arms themselves. */
export const MIN_ARM_TRIALS = 30;
export const MAX_MULTIPLICITY = 10_000;

export type Verdict =
  | "DECISIVE_WORSE"
  | "DECISIVE_BETTER"
  | "DECISIVE_DIFFERENCE"
  | "DECISIVE_BUT_IMMATERIAL"
  | "UNRESOLVED";

export type BenchmarkResult = {
  metric: string;
  successes: number;
  trials: number;
  observedRate: number;
  benchmark: number;
  benchmarkSource: string;
  confidenceInterval: [number, number];
  confidenceLevel: number;
  exactTwoSidedP: number;
  verdict: Verdict;
  alphaUsed: number;
  relativeGap: number;
  unresolvedBecause: string[];
  reads: string;
};

export type ComparisonResult = {
  metric: string;
  a: { successes: number; trials: number; rate: number; confidenceInterval: [number, number] };
  b: { successes: number; trials: number; rate: number; confidenceInterval: [number, number] };
  difference: number;
  differenceConfidenceInterval: [number, number];
  fisherExactP: number;
  verdict: Verdict;
  alphaUsed: number;
  relativeGap: number;
  unresolvedBecause: string[];
  reads: string;
};

// --- primitives -------------------------------------------------------------

/** Inverse standard normal CDF (Acklam), accurate to ~1e-9 — enough for a z. */
export function zFor(alpha: number): number {
  const p = 1 - alpha / 2;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  let q: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function logGamma(x: number): number {
  // Lanczos approximation. Used only via logChoose, where the magnitudes are
  // far too large for factorials in doubles.
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function binomPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
}

/**
 * Two-sided exact binomial p by the method of small probabilities. Conservative
 * next to the score test, which is why it is a cross-check rather than the
 * verdict: when the two disagree this refuses instead of picking the friendlier.
 */
export function exactTwoSidedP(successes: number, trials: number, p0: number): number {
  const observed = binomPmf(successes, trials, p0);
  const tol = observed * 1e-7;
  let total = 0;
  for (let k = 0; k <= trials; k++) {
    const pmf = binomPmf(k, trials, p0);
    if (pmf <= observed + tol) total += pmf;
  }
  return Math.min(1, total);
}

/** Two-tailed Fisher exact for a 2x2 table. Needed at small counts. */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const r1 = a + b;
  const c1 = a + c;
  const c2 = b + d;
  if (n === 0 || r1 === 0 || c1 === 0 || c2 === 0) return 1;
  const logp = (x: number) => logChoose(c1, x) + logChoose(c2, r1 - x) - logChoose(n, r1);
  const lo = Math.max(0, r1 - c2);
  const hi = Math.min(r1, c1);
  const observed = logp(a);
  let total = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logp(x);
    if (lp <= observed + 1e-9) total += Math.exp(lp);
  }
  return Math.min(1, total);
}

/** Wilson score interval — correct at zero successes, unlike Wald. */
export function wilsonInterval(successes: number, trials: number, z: number): [number, number] {
  if (trials === 0) return [0, 1];
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function alphaFor(looks: number, testsRun: number): number {
  return BASE_ALPHA / (looks * testsRun);
}

// --- the two questions ------------------------------------------------------

export type Options = {
  /** How many times this ad has already been evaluated on accumulating data. */
  looks?: number;
  /** How many metric/ad combinations are being tested in this pass. */
  testsRun?: number;
  minEffect?: number;
};

/**
 * Is this metric separated from its benchmark by more than noise, by enough to
 * matter? `benchmarkSource` is required because the benchmark decides the
 * verdict — an unsourced one can manufacture any answer you like.
 */
export function testAgainstBenchmark(
  metric: string,
  successes: number,
  trials: number,
  benchmark: number,
  benchmarkSource: string,
  options: Options = {},
): BenchmarkResult {
  const looks = Math.max(1, options.looks ?? 1);
  const testsRun = Math.max(1, options.testsRun ?? 1);
  const minEffect = options.minEffect ?? DEFAULT_MIN_EFFECT;

  if (trials <= 0) throw new Error("trials must be positive; a metric with no denominator is not a metric");
  if (successes < 0 || successes > trials) throw new Error("successes must be between 0 and trials");
  if (!(benchmark > 0 && benchmark < 1)) throw new Error("benchmark is a decimal rate strictly between 0 and 1");
  if (!benchmarkSource.trim()) {
    throw new Error(
      "benchmarkSource is required: use the account's own trailing rate, an operator-supplied " +
        "figure, or a documented platform median — never a number derived from the ad under test",
    );
  }
  if (looks * testsRun > MAX_MULTIPLICITY) {
    throw new Error(`looks x testsRun above ${MAX_MULTIPLICITY}: nothing here is decidable`);
  }

  const alpha = alphaFor(looks, testsRun);
  const z = zFor(alpha);
  const observed = successes / trials;
  const [low, high] = wilsonInterval(successes, trials, z);
  const p = exactTwoSidedP(successes, trials, benchmark);
  const expected = trials * benchmark;
  const relativeGap = Math.abs(observed - benchmark) / benchmark;

  const unresolvedBecause: string[] = [];
  if (expected < MIN_EXPECTED_EVENTS) {
    unresolvedBecause.push(
      `underpowered: only ${expected.toFixed(2)} events expected under the benchmark; need at least ${MIN_EXPECTED_EVENTS}`,
    );
  }
  if (!(high < benchmark || low > benchmark)) {
    unresolvedBecause.push("the confidence interval still contains the benchmark");
  }
  if (p >= alpha) {
    unresolvedBecause.push(`exact binomial p = ${p.toFixed(4)}, not below alpha = ${alpha.toFixed(4)}`);
  }
  if (observed > benchmark && successes < MIN_OBSERVED_FOR_BETTER) {
    unresolvedBecause.push(
      `only ${successes} observed events; at least ${MIN_OBSERVED_FOR_BETTER} are needed before calling a rate better than benchmark`,
    );
  }

  let verdict: Verdict;
  if (unresolvedBecause.length > 0) verdict = "UNRESOLVED";
  else if (relativeGap < minEffect) verdict = "DECISIVE_BUT_IMMATERIAL";
  else if (high < benchmark) verdict = "DECISIVE_WORSE";
  else verdict = "DECISIVE_BETTER";

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return {
    metric,
    successes,
    trials,
    observedRate: observed,
    benchmark,
    benchmarkSource,
    confidenceInterval: [low, high],
    confidenceLevel: 1 - alpha,
    exactTwoSidedP: p,
    verdict,
    alphaUsed: alpha,
    relativeGap,
    unresolvedBecause,
    reads:
      `${metric} is ${pct(observed)} on ${trials.toLocaleString()} trials; the true rate lies between ` +
      `${pct(low)} and ${pct(high)} against a ${pct(benchmark)} benchmark (${benchmarkSource.trim()}).`,
  };
}

/**
 * Head-to-head between two creatives on one metric.
 *
 * The interval that matters is the one around the DIFFERENCE (Newcombe). Asking
 * whether two per-arm intervals overlap is a different, far stricter test that
 * throws away real winners at exactly the margins a creative test produces —
 * and "the intervals overlap" is not evidence of no difference.
 */
export function compareCreatives(
  metric: string,
  a: { successes: number; trials: number },
  b: { successes: number; trials: number },
  options: Options = {},
): ComparisonResult {
  const looks = Math.max(1, options.looks ?? 1);
  const testsRun = Math.max(1, options.testsRun ?? 1);
  const minEffect = options.minEffect ?? DEFAULT_MIN_EFFECT;

  for (const arm of [a, b]) {
    if (arm.trials <= 0) throw new Error("each arm needs a positive denominator");
    if (arm.successes < 0 || arm.successes > arm.trials) throw new Error("arm successes must be between 0 and trials");
  }

  const alpha = alphaFor(looks, testsRun);
  const z = zFor(alpha);
  const pa = a.successes / a.trials;
  const pb = b.successes / b.trials;
  const [aLow, aHigh] = wilsonInterval(a.successes, a.trials, z);
  const [bLow, bHigh] = wilsonInterval(b.successes, b.trials, z);

  const diff = pa - pb;
  const dLow = diff - Math.sqrt((pa - aLow) ** 2 + (bHigh - pb) ** 2);
  const dHigh = diff + Math.sqrt((aHigh - pa) ** 2 + (pb - bLow) ** 2);
  const fisherP = fisherExactTwoSided(a.successes, a.trials - a.successes, b.successes, b.trials - b.successes);

  const unresolvedBecause: string[] = [];
  if (Math.min(a.trials, b.trials) < MIN_ARM_TRIALS) {
    unresolvedBecause.push(`each arm needs at least ${MIN_ARM_TRIALS} trials; smallest here is ${Math.min(a.trials, b.trials)}`);
  }
  if (Math.max(a.successes, b.successes) < MIN_OBSERVED_FOR_BETTER) {
    unresolvedBecause.push(`the better arm has only ${Math.max(a.successes, b.successes)} events; at least ${MIN_OBSERVED_FOR_BETTER} are needed`);
  }
  if (!(dLow > 0 || dHigh < 0)) unresolvedBecause.push("the interval on the difference still contains zero");
  if (fisherP >= alpha) unresolvedBecause.push(`Fisher exact p = ${fisherP.toFixed(4)}, not below alpha = ${alpha.toFixed(4)}`);

  // Order-invariant on purpose: dividing by one named arm made the verdict flip
  // depending on which creative you happened to pass first.
  const baseline = Math.max(pa, pb);
  const relativeGap = baseline > 0 ? Math.abs(diff) / baseline : 0;

  let verdict: Verdict;
  if (unresolvedBecause.length > 0) verdict = "UNRESOLVED";
  else if (relativeGap < minEffect) verdict = "DECISIVE_BUT_IMMATERIAL";
  else verdict = "DECISIVE_DIFFERENCE";

  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  return {
    metric,
    a: { ...a, rate: pa, confidenceInterval: [aLow, aHigh] },
    b: { ...b, rate: pb, confidenceInterval: [bLow, bHigh] },
    difference: diff,
    differenceConfidenceInterval: [dLow, dHigh],
    fisherExactP: fisherP,
    verdict,
    alphaUsed: alpha,
    relativeGap,
    unresolvedBecause,
    reads:
      `A is ${pct(pa)}, B is ${pct(pb)}; the difference is ${pct(diff)} with interval ` +
      `[${pct(dLow)}, ${pct(dHigh)}]${unresolvedBecause.length ? " — not settled" : ""}.`,
  };
}

/**
 * What each metric is blind to. Attached to every verdict so a decided CTR is
 * never reported as if it settled conversion — certainty does not travel
 * between metrics, and this is the field that keeps saying so.
 */
export const BLIND_SPOTS: Record<string, string[]> = {
  ctr: [
    "conversion rate, add-to-cart rate, CPA and ROAS — all sit on the click denominator",
    "whether the landing page works",
    "whether the audience is right",
  ],
  atc_rate: ["checkout completion and purchase rate", "whether the hook is working", "revenue per order"],
  cvr: ["whether the creative earned attention", "pricing, page, offer and checkout friction are indistinguishable here"],
  view_rate: ["whether attention converted into intent", "anything downstream of the click"],
  checkout_rate: ["whether the creative or the audience was at fault upstream", "refund behaviour"],
};

/** CPA and ROAS are ratios of money, not proportions. Refuse them by name. */
export const NOT_PROPORTIONS = new Set(["roas", "cpa", "cpc", "cpm", "aov", "revenue", "spend", "frequency"]);
