import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { compareCreatives, testAgainstBenchmark, wilsonInterval, zFor } from "./stats";
import {
  ActionLog,
  DEFAULT_GUARDRAILS,
  emergencyFreeze,
  evaluateAction,
  type ProposedAction,
  type SpendState,
} from "./guardrails";
import {
  assertNoVerbatimCopy,
  buildReference,
  extractTasteSignals,
  inferPacing,
  inferPlatform,
  referenceIdFor,
  summariseLibrary,
  upsertPattern,
} from "./reference-library";
import { buildLandingUrl, createExperiment, utmContentFor, validateExperimentArms } from "./experiments";
import { SimulationTikTokClient, assessTikTokReadiness } from "./tiktok-client";
import { aggregate, decide, derive, rankByAttribute, type Benchmarks } from "./decisions";
import type { CreativePattern, PerformanceSnapshot, VantaCreative } from "./types";

const SRC = "account trailing 30d rate";

describe("stats — per-metric decisions", () => {
  it("decides the hook and refuses the conversion rate on the same ad", () => {
    const ctr = testAgainstBenchmark("ctr", 13, 1900, 0.021, SRC);
    const cvr = testAgainstBenchmark("cvr", 0, 13, 0.05, SRC);
    expect(ctr.verdict).toBe("DECISIVE_WORSE");
    expect(cvr.verdict).toBe("UNRESOLVED");
    expect(cvr.unresolvedBecause.join(" ")).toContain("underpowered");
  });

  it("refuses tiny samples that an interval alone would call decisive", () => {
    for (const [s, t, b] of [
      [1, 3, 0.02],
      [3, 20, 0.05],
      [1, 8, 0.021],
      [0, 75, 0.05],
      [30, 1000, 0.021],
    ] as const) {
      expect(testAgainstBenchmark("cvr", s, t, b, SRC).verdict).toBe("UNRESOLVED");
    }
  });

  it("never returns DECISIVE with an exact p at or above alpha", () => {
    const violations: string[] = [];
    for (const benchmark of [0.021, 0.05]) {
      for (const trials of [3, 8, 20, 50, 75, 100, 300, 1000]) {
        for (let successes = 0; successes <= Math.min(trials, 40); successes++) {
          const r = testAgainstBenchmark("cvr", successes, trials, benchmark, SRC);
          if (r.verdict.startsWith("DECISIVE") && r.exactTwoSidedP >= r.alphaUsed) {
            violations.push(`${successes}/${trials}@${benchmark}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("separates real from important", () => {
    expect(testAgainstBenchmark("ctr", 20500, 1_000_000, 0.021, SRC).verdict).toBe("DECISIVE_BUT_IMMATERIAL");
    expect(testAgainstBenchmark("ctr", 20500, 1_000_000, 0.021, SRC, { minEffect: 0 }).verdict).toBe("DECISIVE_WORSE");
  });

  it("tightens alpha for repeated looks and multiple tests", () => {
    const one = testAgainstBenchmark("ctr", 100, 10_000, 0.0125, SRC);
    const many = testAgainstBenchmark("ctr", 100, 10_000, 0.0125, SRC, { looks: 14 });
    expect(one.verdict.startsWith("DECISIVE")).toBe(true);
    expect(many.verdict).toBe("UNRESOLVED");
    expect(many.alphaUsed).toBeCloseTo(0.05 / 14, 10);
    // A genuinely decisive result survives the correction.
    expect(testAgainstBenchmark("ctr", 13, 1900, 0.021, SRC, { looks: 14 }).verdict).toBe("DECISIVE_WORSE");
  });

  it("requires a sourced benchmark", () => {
    expect(() => testAgainstBenchmark("ctr", 13, 1900, 0.021, "   ")).toThrow(/benchmarkSource is required/);
  });

  it("compares head to head on the difference, symmetrically", () => {
    const fwd = compareCreatives("ctr", { successes: 100, trials: 1000 }, { successes: 130, trials: 1000 });
    const rev = compareCreatives("ctr", { successes: 130, trials: 1000 }, { successes: 100, trials: 1000 });
    expect(fwd.verdict).toBe("DECISIVE_DIFFERENCE");
    expect(rev.verdict).toBe(fwd.verdict);
    expect(rev.relativeGap).toBeCloseTo(fwd.relativeGap, 12);
  });

  it("refuses tiny head-to-head comparisons Fisher would reject", () => {
    for (const [a, b] of [
      [{ successes: 2, trials: 2 }, { successes: 0, trials: 2 }],
      [{ successes: 5, trials: 10 }, { successes: 10, trials: 50 }],
      [{ successes: 4, trials: 20 }, { successes: 10, trials: 20 }],
    ] as const) {
      expect(compareCreatives("ctr", a, b).verdict).toBe("UNRESOLVED");
    }
  });

  it("computes a Wilson interval that is correct at zero successes", () => {
    const [low, high] = wilsonInterval(0, 13, zFor(0.05));
    expect(low).toBe(0);
    expect(high).toBeCloseTo(0.2281, 4);
  });
});

// The Python in the Creative Director skill and this TypeScript must remain the
// same function. Two implementations of one statistic is a drift hazard, and a
// drift here means the analyst and the runtime recommend different things.
describe("stats — parity with the skill's decisive.py", () => {
  const script = path.resolve(process.cwd(), "../.claude/skills/vanta-creative-director/scripts/decisive.py");
  const cases: [number, number, number][] = [
    [13, 1900, 0.021],
    [0, 13, 0.05],
    [1, 3, 0.02],
    [3, 20, 0.05],
    [0, 75, 0.05],
    [30, 1000, 0.021],
    [500, 10000, 0.021],
    [210, 10000, 0.021],
    [0, 50, 0.05],
    [100, 10000, 0.021],
  ];

  it.skipIf(!existsSync(script))("agrees on verdict and interval for every case", () => {
    for (const [successes, trials, benchmark] of cases) {
      const raw = execFileSync(
        "python3",
        [script, "--metric", "cvr", "--successes", String(successes), "--trials", String(trials),
          "--benchmark", String(benchmark), "--benchmark-source", SRC],
        { encoding: "utf8" },
      );
      const py = JSON.parse(raw);
      const ts = testAgainstBenchmark("cvr", successes, trials, benchmark, SRC);
      expect(ts.verdict, `verdict ${successes}/${trials}@${benchmark}`).toBe(py.verdict);
      expect(ts.confidenceInterval[0]).toBeCloseTo(py.confidence_interval[0], 4);
      expect(ts.confidenceInterval[1]).toBeCloseTo(py.confidence_interval[1], 4);
      expect(ts.exactTwoSidedP).toBeCloseTo(py.exact_two_sided_p, 5);
    }
  });
});

describe("guardrails — money safety", () => {
  const spend: SpendState = { todaySpend: 10, committedDailyBudget: 40 };
  const increase: ProposedAction = {
    actionId: "a1",
    type: "increase_budget",
    campaignId: "c1",
    dailyBudgetDelta: 5,
    resultingCampaignDailyBudget: 35,
    rationale: "winner",
    evidence: {},
  };

  it("executes nothing in the default recommend mode", () => {
    const ruling = evaluateAction(increase, DEFAULT_GUARDRAILS, spend, 30);
    expect(ruling.allowed).toBe(false);
    expect(ruling.requiresHumanApproval).toBe(true);
    expect(ruling.violations.join(" ")).toContain("recommend");
  });

  it("refuses to breach the account ceiling even in autonomous mode", () => {
    const g = { ...DEFAULT_GUARDRAILS, mode: "autonomous" as const, autoApprovedActions: ["increase_budget" as const] };
    const ruling = evaluateAction(increase, g, { todaySpend: 10, committedDailyBudget: 98 }, 30);
    expect(ruling.allowed).toBe(false);
    expect(ruling.violations.join(" ")).toContain("account ceiling");
  });

  it("caps the size of a single automatic increase", () => {
    const g = { ...DEFAULT_GUARDRAILS, mode: "autonomous" as const, autoApprovedActions: ["increase_budget" as const] };
    const big: ProposedAction = { ...increase, dailyBudgetDelta: 30, resultingCampaignDailyBudget: 40 };
    const ruling = evaluateAction(big, g, { todaySpend: 0, committedDailyBudget: 10 }, 10);
    expect(ruling.allowed).toBe(false);
    expect(ruling.violations.join(" ")).toMatch(/step limit/);
  });

  it("lets a pause through unattended but never a spend increase", () => {
    const g = { ...DEFAULT_GUARDRAILS, mode: "autonomous" as const };
    const pause: ProposedAction = { actionId: "a2", type: "pause_ad", adId: "ad1", dailyBudgetDelta: -5, rationale: "loser", evidence: {} };
    expect(evaluateAction(pause, g, spend).allowed).toBe(true);
    expect(evaluateAction(increase, g, spend, 30).allowed).toBe(false);
    expect(DEFAULT_GUARDRAILS.autoApprovedActions).not.toContain("increase_budget");
    expect(DEFAULT_GUARDRAILS.autoApprovedActions).not.toContain("publish_ad");
  });

  it("stops everything when frozen", () => {
    const frozen = emergencyFreeze({ ...DEFAULT_GUARDRAILS, mode: "autonomous" }, "owner pressed stop");
    const pause: ProposedAction = { actionId: "a3", type: "pause_ad", adId: "ad1", dailyBudgetDelta: -5, rationale: "x", evidence: {} };
    expect(evaluateAction(pause, frozen, spend).allowed).toBe(false);
    expect(frozen.mode).toBe("recommend");
  });

  it("records an inverse for anything reversible", () => {
    const ruling = evaluateAction(increase, DEFAULT_GUARDRAILS, spend, 30);
    expect(ruling.inverse).toEqual(expect.objectContaining({ type: "decrease_budget", restoreDailyBudget: 30 }));
  });

  it("keeps the action log append-only", () => {
    const log = new ActionLog();
    const entry = {
      actionId: "a1", at: "2026-08-09T00:00:00Z", type: "pause_ad" as const,
      proposal: { actionId: "a1", type: "pause_ad" as const, dailyBudgetDelta: -1, rationale: "x", evidence: {} },
      ruling: { allowed: true, requiresHumanApproval: false, violations: [], inverse: null },
      executed: true,
    };
    log.append(entry);
    expect(() => log.append(entry)).toThrow(/append-only/);
    log.markReverted("a1", "a2");
    expect(log.all()[0].revertedBy).toBe("a2");
    expect(log.rollbackCandidates("2026-08-08T00:00:00Z")).toHaveLength(0);
  });
});

describe("reference library", () => {
  const now = "2026-08-09T12:00:00Z";

  it("infers the platform and gives the same URL the same id", () => {
    expect(inferPlatform("https://www.tiktok.com/@x/video/123")).toBe("tiktok");
    expect(inferPlatform("https://instagram.com/reel/abc")).toBe("reels");
    const a = referenceIdFor({ url: "https://www.tiktok.com/@x/video/123" }, now);
    const b = referenceIdFor({ url: "HTTPS://WWW.TIKTOK.COM/@X/VIDEO/123 " }, now);
    expect(a).toBe(b);
  });

  it("accepts a bare URL with a note", () => {
    const ref = buildReference({ url: "https://www.tiktok.com/@x/video/1", note: "I love the lighting in this" }, now);
    expect(ref.source.platform).toBe("tiktok");
    expect(ref.ownerVerdict?.some((s) => s.dimension === "lighting" && s.sentiment === "like")).toBe(true);
    expect(ref.doNotCopy).toEqual([]);
  });

  it("reads negation in a taste note rather than counting it as approval", () => {
    const positive = extractTasteSignals("I like this hook", "ref-1", now);
    const negative = extractTasteSignals("I don't like this hook", "ref-1", now);
    expect(positive.find((s) => s.dimension === "hook")?.sentiment).toBe("like");
    expect(negative.find((s) => s.dimension === "hook")?.sentiment).toBe("dislike");
    expect(extractTasteSignals("this looks cheap", "ref-1", now)[0].sentiment).toBe("dislike");
  });

  it("blocks a script that reuses a reference's wording", () => {
    const refs = [{ referenceId: "ref-1", observed: { hook: "stop scrolling if you care about what is in your vial" } }];
    const copied = assertNoVerbatimCopy("stop scrolling if you care about what is in your vial today", refs);
    expect(copied.ok).toBe(false);
    expect(copied.matchedReferenceIds).toEqual(["ref-1"]);
    const original = assertNoVerbatimCopy("search your lot number and read the actual report", refs);
    expect(original.ok).toBe(true);
  });

  it("merges a repeated pattern instead of duplicating it", () => {
    let library: CreativePattern[] = [];
    const draft = { name: "Open on the document", dimension: "opening_frame" as const, principle: "Lead with the artefact, not the claim" };
    library = upsertPattern(library, draft, "ref-1");
    library = upsertPattern(library, draft, "ref-2");
    library = upsertPattern(library, draft, "ref-2");
    expect(library).toHaveLength(1);
    expect(library[0].observedInReferenceIds).toEqual(["ref-1", "ref-2"]);
  });

  it("summarises the library and flags unanalysed references", () => {
    const refs = [
      buildReference({ url: "https://www.tiktok.com/@a/video/1", note: "great hook" }, now),
      buildReference({ url: "https://www.tiktok.com/@b/video/2", observed: { format: "ugc" } }, now),
    ];
    const summary = summariseLibrary(refs, []);
    expect(summary.references).toBe(2);
    expect(summary.byPlatform.tiktok).toBe(2);
    expect(summary.unanalysed).toHaveLength(1);
  });

  it("infers pacing from shots and duration", () => {
    expect(inferPacing(3, 15)).toBe("slow");
    expect(inferPacing(12, 15)).toBe("fast");
    expect(inferPacing(30, 15)).toBe("frenetic");
    expect(inferPacing(undefined, 15)).toBeUndefined();
  });
});

function creative(overrides: Partial<VantaCreative> = {}): VantaCreative {
  return {
    creativeId: "vl-doc-001",
    conceptId: "concept-doc",
    variantOf: null,
    variantAxis: "hook",
    archetype: "documentation",
    status: "concept",
    createdAt: "2026-08-09T00:00:00Z",
    hook: "base hook",
    openingFrame: "report on a dark field",
    script: "…",
    storyboard: [],
    caption: "…",
    cta: "Search your lot number",
    landingPath: "/coa-library",
    audienceHypothesis: "buyers who verify",
    lengthSeconds: 12,
    claimsUsed: [],
    eligibility: "needs_verification",
    inspiredByReferenceIds: [],
    usesPatternIds: [],
    mediaRequests: [],
    platformRefs: null,
    ...overrides,
  };
}

describe("experiments", () => {
  it("accepts arms that differ only on the declared axis", () => {
    const arms = [creative({ creativeId: "a", hook: "h1" }), creative({ creativeId: "b", hook: "h2" })];
    expect(validateExperimentArms("hook", arms).valid).toBe(true);
  });

  it("rejects arms that move two variables at once", () => {
    const arms = [creative({ creativeId: "a", hook: "h1" }), creative({ creativeId: "b", hook: "h2", cta: "Shop now" })];
    const result = validateExperimentArms("hook", arms);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("'cta'");
  });

  it("rejects two identical arms", () => {
    const arms = [creative({ creativeId: "a", hook: "same" }), creative({ creativeId: "b", hook: "same" })];
    expect(validateExperimentArms("hook", arms).problems.join(" ")).toContain("nothing to compare");
  });

  it("builds a landing URL carrying a stable per-creative token", () => {
    const url = buildLandingUrl({
      baseUrl: "https://vantalabsresearch.com",
      landingPath: "/coa-library",
      creativeId: "vl-doc-001",
      campaignName: "aug-doc-test",
    });
    expect(url).toContain("utm_content=vl-doc-001");
    expect(url).toContain("utm_source=tiktok");
    // ttclid is appended by TikTok at click time; a placeholder here would be
    // captured as a literal and treated as a real click id.
    expect(url).not.toContain("ttclid");
    expect(utmContentFor("VL_Doc 001")).toBe("vl-doc-001");
  });

  it("refuses to create an experiment from invalid arms", () => {
    expect(() =>
      createExperiment({
        experimentId: "e1", name: "x", hypothesis: "y", axis: "hook",
        arms: [creative({ creativeId: "a", hook: "h1" }), creative({ creativeId: "b", hook: "h2", landingPath: "/products" })],
      }),
    ).toThrow(/landingPath/);
  });
});

describe("tiktok client — simulation only", () => {
  it("records intent and spends nothing", async () => {
    const client = new SimulationTikTokClient(() => "2026-08-09T00:00:00Z");
    const { campaignId } = await client.createCampaign({ name: "c", objective: "TRAFFIC", dailyBudget: 20 });
    const { adGroupId } = await client.createAdGroup({ campaignId, name: "g", dailyBudget: 20, landingUrl: "https://x.test/" });
    const refs = await client.publishAd({
      adGroupId, name: "ad", creativeId: "vl-doc-001", videoAssetPath: "/tmp/a.mp4",
      caption: "c", callToAction: "LEARN_MORE",
      landingUrl: "https://x.test/coa-library?utm_content=vl-doc-001",
    });
    expect(client.mode).toBe("simulation");
    expect(campaignId).toMatch(/^sim-/);
    expect(refs.utmContent).toBe("vl-doc-001");
    expect(client.calledWith().map((c) => c.method)).toEqual(["createCampaign", "createAdGroup", "publishAd"]);
  });

  it("refuses to publish an ad with no tracking token", async () => {
    const client = new SimulationTikTokClient();
    await expect(
      client.publishAd({
        adGroupId: "g", name: "ad", creativeId: "vl-doc-001", videoAssetPath: "/tmp/a.mp4",
        caption: "c", callToAction: "LEARN_MORE", landingUrl: "https://x.test/coa-library",
      }),
    ).rejects.toThrow(/untrackable/);
  });

  it("never fabricates performance data", async () => {
    const client = new SimulationTikTokClient();
    await expect(client.fetchReport({ since: "2026-08-01", until: "2026-08-09" })).resolves.toEqual([]);
  });

  it("reports readiness honestly", () => {
    const report = assessTikTokReadiness({});
    expect(report.ready).toBe(false);
    expect(report.missing).toContain("TIKTOK_ADS_ACCESS_TOKEN");
    expect(report.blockedOn.join(" ")).toContain("eligibility");
  });
});

function snapshot(overrides: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    snapshotId: "s1", creativeId: "vl-doc-001", platform: "tiktok",
    campaignId: "c", adGroupId: "g", adId: "a", statDate: "2026-08-08",
    spend: 890, impressions: 41000, clicks: 860, siteSessions: 800,
    siteAddToCarts: 31, siteCheckouts: 12, sitePurchases: 3, siteRevenue: 420, siteRefunds: 0,
    recordedAt: "2026-08-09T00:00:00Z", ...overrides,
  };
}

const benchmarks: Benchmarks = {
  ctr: { value: 0.021, source: SRC },
  atcRate: { value: 0.07, source: SRC },
  cvr: { value: 0.02, source: SRC },
  targetCpa: 60,
  targetRoas: 2,
};

describe("decision engine", () => {
  it("derives metrics net of refunds", () => {
    const m = derive(snapshot({ siteRefunds: 120 }));
    expect(m.ctr).toBeCloseTo(0.02098, 5);
    expect(m.cpa).toBeCloseTo(296.67, 2);
    expect(m.roas).toBeCloseTo((420 - 120) / 890, 5);
    expect(m.atcRate).toBeCloseTo(31 / 860, 5);
  });

  it("calls a weak hook and says what remains unresolved", () => {
    const d = decide({
      creativeId: "vl-b", snapshot: snapshot({ impressions: 1900, clicks: 13, siteAddToCarts: 0, sitePurchases: 0, siteRevenue: 0, spend: 95 }),
      benchmarks, daysRunning: 2, minConversionsToScale: 10, minDaysToScale: 7, now: "2026-08-09T00:00:00Z",
    });
    expect(d.action).toBe("retire_hook");
    expect(d.decidedMetrics).toContain("ctr");
    expect(d.unresolvedMetrics).toContain("cvr");
    expect(d.rationale).toContain("UNRESOLVED");
    expect(d.autoExecutable).toBe(false);
  });

  it("blames the funnel, not the creative, when the ad works and the page does not", () => {
    const d = decide({
      creativeId: "vl-a", snapshot: snapshot({ impressions: 41000, clicks: 1600, siteAddToCarts: 20 }),
      benchmarks, daysRunning: 9, minConversionsToScale: 10, minDaysToScale: 7, now: "2026-08-09T00:00:00Z",
    });
    expect(d.action).toBe("investigate_funnel");
    expect(d.rationale).toContain("not a creative problem");
  });

  it("keeps running when nothing is decided", () => {
    const d = decide({
      creativeId: "vl-c", snapshot: snapshot({ impressions: 300, clicks: 6, siteAddToCarts: 0, sitePurchases: 0, spend: 8, siteRevenue: 0 }),
      benchmarks, daysRunning: 1, minConversionsToScale: 10, minDaysToScale: 7, now: "2026-08-09T00:00:00Z",
    });
    expect(d.action).toBe("keep_running");
    expect(d.decidedMetrics).toEqual([]);
  });

  it("will not scale on a thin sample even when the metric is decided", () => {
    const strong = snapshot({ impressions: 4000, clicks: 200, siteAddToCarts: 20, siteCheckouts: 8, sitePurchases: 4, siteRevenue: 900, spend: 300 });
    const d = decide({
      creativeId: "vl-d", snapshot: strong, benchmarks,
      daysRunning: 3, minConversionsToScale: 10, minDaysToScale: 7, now: "2026-08-09T00:00:00Z",
    });
    expect(d.action).toBe("produce_variants");
    expect(d.rationale).toMatch(/conversions|days/);
  });

  it("aggregates a window without inventing fields", () => {
    const agg = aggregate([snapshot({ statDate: "2026-08-07" }), snapshot({ statDate: "2026-08-08" })])!;
    expect(agg.spend).toBe(1780);
    expect(agg.sitePurchases).toBe(6);
    expect(aggregate([])).toBeNull();
  });

  it("ranks attributes by return with the evidence count attached", () => {
    const ranked = rankByAttribute([
      { creativeId: "a", attribute: "documentation", snapshot: snapshot({ spend: 100, siteRevenue: 400, sitePurchases: 4 }) },
      { creativeId: "b", attribute: "documentation", snapshot: snapshot({ spend: 100, siteRevenue: 200, sitePurchases: 2 }) },
      { creativeId: "c", attribute: "ugc", snapshot: snapshot({ spend: 100, siteRevenue: 50, sitePurchases: 1 }) },
    ]);
    expect(ranked[0].attribute).toBe("documentation");
    expect(ranked[0].creatives).toBe(2);
    expect(ranked[0].roas).toBeCloseTo(3, 5);
  });
});
