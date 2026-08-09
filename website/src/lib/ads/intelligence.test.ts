import { describe, expect, it } from "vitest";
import { classify, type CreativeClassification } from "./taxonomy";
import {
  ancestry,
  buildBeliefs,
  descendants,
  diffCreatives,
  formHypothesis,
  gradeEvidence,
  retirementLesson,
  summariseBelief,
  type Hypothesis,
  type LineageNode,
} from "./learning";
import { assessFatigue, detectAnomalies, type DailyPoint } from "./monitoring";
import {
  advanceJob,
  exploitBrief,
  exploreBrief,
  exploreRatio,
  generateBriefBatch,
  queueGeneration,
  untestedValues,
} from "./briefs";
import { compareCreatives } from "./stats";

const NOW = "2026-08-09T00:00:00Z";
const cls = (patch: Partial<CreativeClassification> = {}): CreativeClassification => ({
  ...classify({}, "human", NOW).classification,
  ...patch,
});
const node = (id: string, parentId: string | null, c: CreativeClassification, gen = 0): LineageNode => ({
  creativeId: id, parentId, rootId: "vl-001", generation: gen, classification: c, createdAt: NOW,
});

describe("lineage", () => {
  const a = node("vl-001", null, cls({ hookType: "question", visualStyle: "studio_product", ctaType: "shop_now" }));
  const b = node("vl-002", "vl-001", cls({ hookType: "document_reveal", visualStyle: "studio_product", ctaType: "shop_now" }), 1);
  const c = node("vl-003", "vl-002", cls({ hookType: "document_reveal", visualStyle: "cinematic_macro", ctaType: "shop_now" }), 2);

  it("reports exactly what changed between two creatives", () => {
    expect(diffCreatives(a.classification, b.classification)).toEqual([
      { axis: "hookType", from: "question", to: "document_reveal" },
    ]);
  });

  it("reports every difference when more than one moved", () => {
    expect(diffCreatives(a.classification, c.classification)).toHaveLength(2);
  });

  it("walks ancestry root-first and finds descendants", () => {
    expect(ancestry([a, b, c], "vl-003").map((n) => n.creativeId)).toEqual(["vl-001", "vl-002", "vl-003"]);
    expect(descendants([a, b, c], "vl-001").map((n) => n.creativeId)).toEqual(["vl-002", "vl-003"]);
  });

  it("survives a cycle rather than hanging", () => {
    const x = node("x", "y", cls());
    const y = node("y", "x", cls());
    expect(ancestry([x, y], "x").length).toBeLessThanOrEqual(2);
  });
});

describe("hypothesis formation — the causal discipline", () => {
  const control = node("vl-001", null, cls({ hookType: "question" }));
  const variant = node("vl-002", "vl-001", cls({ hookType: "document_reveal" }), 1);
  const decisive = compareCreatives("ctr", { successes: 130, trials: 1000 }, { successes: 100, trials: 1000 });

  it("names the single attribute that changed and refuses to call it proven", () => {
    const h = formHypothesis({ hypothesisId: "h1", control, variant, comparison: decisive, metric: "ctr", conversions: 20, now: NOW });
    expect(h.axis).toBe("hookType");
    expect(h.from).toBe("question");
    expect(h.to).toBe("document_reveal");
    expect(h.statement).toMatch(/associated with/i);
    expect(h.statement).not.toMatch(/caused|proves/i);
    expect(h.caveat).toMatch(/not proof/i);
    expect(h.status).toBe("supported");
  });

  it("refuses to credit any attribute when several moved", () => {
    const messy = node("vl-009", "vl-001", cls({ hookType: "document_reveal", ctaType: "verify_lookup", pacing: "fast" }), 1);
    const h = formHypothesis({ hypothesisId: "h2", control, variant: messy, comparison: decisive, metric: "ctr", conversions: 20, now: NOW });
    expect(h.axis).toBe("multiple");
    expect(h.status).toBe("inconclusive");
    expect(h.confounds).toHaveLength(3);
    expect(h.caveat).toMatch(/Unattributable/i);
  });

  it("flags a comparison where nothing classified changed", () => {
    const twin = node("vl-010", "vl-001", cls({ hookType: "question" }), 1);
    const h = formHypothesis({ hypothesisId: "h3", control, variant: twin, comparison: decisive, metric: "ctr", conversions: 20, now: NOW });
    expect(h.axis).toBe("unknown");
    expect(h.caveat).toMatch(/unrecorded/);
  });

  it("marks an indecisive comparison inconclusive whatever the lift looks like", () => {
    const noisy = compareCreatives("ctr", { successes: 6, trials: 40 }, { successes: 4, trials: 40 });
    const h = formHypothesis({ hypothesisId: "h4", control, variant, comparison: noisy, metric: "ctr", conversions: 2, now: NOW });
    expect(h.status).toBe("inconclusive");
    expect(h.strength).toBe("anecdotal");
  });

  it("grades evidence on conversions and replication, never reaching certainty", () => {
    expect(gradeEvidence({ decisive: false, conversions: 500 })).toBe("anecdotal");
    expect(gradeEvidence({ decisive: true, conversions: 6 })).toBe("suggestive");
    expect(gradeEvidence({ decisive: true, conversions: 20 })).toBe("supported");
    expect(gradeEvidence({ decisive: true, conversions: 40, independentReplications: 2 })).toBe("strong");
  });
});

describe("the evidence ledger", () => {
  const h = (id: string, from: string, to: string, lift: number, conversions: number): Hypothesis => ({
    hypothesisId: id, statement: "", axis: "hookType", from, to,
    controlCreativeId: "c", variantCreativeId: "v", observedLift: lift, metric: "ctr",
    conversions, strength: "supported", caveat: "", confounds: [], createdAt: NOW, status: "supported",
  });

  it("credits the winner and debits the loser of every comparison", () => {
    const beliefs = buildBeliefs([h("h1", "question", "document_reveal", 0.4, 20)]);
    const winner = beliefs.find((b) => b.value === "document_reveal")!;
    const loser = beliefs.find((b) => b.value === "question")!;
    expect(winner.supportingComparisons).toBe(1);
    expect(loser.contradictingComparisons).toBe(1);
    expect(loser.score).toBeLessThan(0);
  });

  it("marks an attribute discouraged once it repeatedly loses", () => {
    const beliefs = buildBeliefs([
      h("h1", "question", "document_reveal", 0.4, 20),
      h("h2", "question", "curiosity_gap", 0.3, 20),
    ]);
    const question = beliefs.find((b) => b.value === "question")!;
    expect(question.discouraged).toBe(true);
    expect(summariseBelief(question)).toMatch(/discouraged/);
  });

  it("excludes unattributable comparisons from the ledger entirely", () => {
    const multi: Hypothesis = { ...h("h9", "a", "b", 0.5, 30), axis: "multiple" };
    expect(buildBeliefs([multi])).toEqual([]);
  });

  it("excludes inconclusive comparisons", () => {
    const weak: Hypothesis = { ...h("h8", "question", "document_reveal", 0.4, 30), status: "inconclusive" };
    expect(buildBeliefs([weak])).toEqual([]);
  });

  it("strengthens with independent replication", () => {
    const once = buildBeliefs([h("h1", "question", "document_reveal", 0.4, 20)]);
    const thrice = buildBeliefs([
      h("h1", "question", "document_reveal", 0.4, 20),
      h("h2", "bold_claim", "document_reveal", 0.3, 20),
      h("h3", "negative", "document_reveal", 0.2, 20),
    ]);
    const a = once.find((b) => b.value === "document_reveal")!;
    const c = thrice.find((b) => b.value === "document_reveal")!;
    expect(c.supportingComparisons).toBeGreaterThan(a.supportingComparisons);
    expect(c.strength).toBe("strong");
  });

  it("keeps losers as retrievable lessons rather than deleting them", () => {
    const beliefs = buildBeliefs([
      h("h1", "question", "document_reveal", 0.4, 20),
      h("h2", "question", "curiosity_gap", 0.3, 20),
    ]);
    const lesson = retirementLesson(
      { creativeId: "vl-dead", classification: cls({ hookType: "question" }), retiredAt: NOW, reason: "weak hook", spendBeforeRetirement: 120, conversions: 0 },
      beliefs,
    );
    expect(lesson).toMatch(/hookType=question/);
    expect(retirementLesson(
      { creativeId: "vl-ok", classification: cls({ hookType: "document_reveal" }), retiredAt: NOW, reason: "budget", spendBeforeRetirement: 10, conversions: 1 },
      beliefs,
    )).toBeNull();
  });
});

describe("fatigue — a shape over time, not a threshold", () => {
  const day = (statDate: string, impressions: number, clicks: number, spend = 50): DailyPoint =>
    ({ statDate, impressions, clicks, spend, conversions: 2, revenue: 100 });

  it("refuses to judge fatigue on a short series", () => {
    const a = assessFatigue("vl-a", [day("2026-08-01", 1000, 30), day("2026-08-02", 1000, 10)]);
    expect(a.state).toBe("insufficient_data");
    expect(a.recommendation).toMatch(/Keep running/);
  });

  it("calls a decisive decline from a creative's own peak fatigued", () => {
    const series = [
      day("2026-08-01", 20000, 600), day("2026-08-02", 20000, 620), day("2026-08-03", 20000, 610),
      day("2026-08-04", 20000, 500), day("2026-08-05", 20000, 380), day("2026-08-06", 20000, 300),
      day("2026-08-07", 20000, 280), day("2026-08-08", 20000, 260),
    ];
    const a = assessFatigue("vl-a", series);
    expect(a.state).toBe("fatigued");
    expect(a.declineFromPeak).toBeGreaterThan(0.3);
    expect(a.recommendation).toMatch(/rotating/);
    expect(a.spendStable).toBe(true);
  });

  it("leaves a steady creative alone", () => {
    const series = Array.from({ length: 10 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`, 20000, 600));
    expect(assessFatigue("vl-a", series).state).toBe("healthy");
  });

  it("does not call a small wobble on thin traffic fatigued", () => {
    const series = [
      day("2026-08-01", 300, 9), day("2026-08-02", 300, 9), day("2026-08-03", 300, 8),
      day("2026-08-04", 300, 7), day("2026-08-05", 300, 6), day("2026-08-06", 300, 6),
      day("2026-08-07", 300, 5), day("2026-08-08", 300, 5),
    ];
    const a = assessFatigue("vl-a", series);
    expect(a.state).not.toBe("fatigued");
  });

  it("distinguishes wear-out from a spend change", () => {
    const series = [
      day("2026-08-01", 20000, 600, 50), day("2026-08-02", 20000, 620, 50), day("2026-08-03", 20000, 610, 50),
      day("2026-08-04", 60000, 900, 200), day("2026-08-05", 60000, 700, 200), day("2026-08-06", 60000, 600, 200),
      day("2026-08-07", 60000, 560, 200), day("2026-08-08", 60000, 540, 200),
    ];
    const a = assessFatigue("vl-a", series);
    expect(a.spendStable).toBe(false);
    if (a.state === "fatigued") expect(a.reasoning).toMatch(/auction/);
  });
});

describe("anomaly detection", () => {
  const steady = Array.from({ length: 14 }, (_, i) => ({
    statDate: `2026-07-${String(i + 10).padStart(2, "0")}`,
    impressions: 10000 + (i % 3) * 200, clicks: 200 + (i % 3) * 5, spend: 100 + (i % 3),
    conversions: 5 + (i % 2), revenue: 500,
  }));

  it("stays quiet on a normal day", () => {
    expect(detectAnomalies(steady, { statDate: "2026-08-01", impressions: 10200, clicks: 205, spend: 101, conversions: 5, revenue: 500 })).toEqual([]);
  });

  it("needs a baseline before it says anything", () => {
    expect(detectAnomalies(steady.slice(0, 3), { statDate: "2026-08-01", impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 })).toEqual([]);
  });

  it("catches a traffic collapse and says what to check", () => {
    const found = detectAnomalies(steady, { statDate: "2026-08-01", impressions: 200, clicks: 4, spend: 3, conversions: 0, revenue: 0 });
    const collapse = found.find((a) => a.kind === "traffic_collapse")!;
    expect(collapse).toBeTruthy();
    expect(collapse.investigate).toMatch(/campaign is still active/);
  });

  it("catches a spend spike", () => {
    const found = detectAnomalies(steady, { statDate: "2026-08-01", impressions: 11000, clicks: 210, spend: 900, conversions: 5, revenue: 500 });
    expect(found.some((a) => a.kind === "spend_spike")).toBe(true);
  });

  it("recognises clicks with zero conversions as a measurement break, not a demand change", () => {
    const found = detectAnomalies(steady, { statDate: "2026-08-01", impressions: 10000, clicks: 200, spend: 100, conversions: 0, revenue: 0 });
    const flow = found.find((a) => a.kind === "event_flow_break")!;
    expect(flow.severity).toBe("urgent");
    expect(flow.investigate).toMatch(/pixel/);
  });

  it("treats a frozen feed as no baseline rather than infinite confidence", () => {
    const frozen = Array.from({ length: 10 }, (_, i) => ({
      statDate: `2026-07-${String(i + 10).padStart(2, "0")}`,
      impressions: 1000, clicks: 20, spend: 10, conversions: 1, revenue: 100,
    }));
    expect(detectAnomalies(frozen, { statDate: "2026-08-01", impressions: 5, clicks: 0, spend: 0, conversions: 0, revenue: 0 })
      .some((a) => a.kind === "traffic_collapse")).toBe(false);
  });
});

describe("brief generation — exploit and explore", () => {
  const product = { name: "BPC-157", landingPath: "/coa-library" };
  const beliefs = buildBeliefs([
    { hypothesisId: "h1", statement: "", axis: "hookType", from: "question", to: "document_reveal", controlCreativeId: "c", variantCreativeId: "v", observedLift: 0.4, metric: "ctr", conversions: 30, strength: "supported", caveat: "", confounds: [], createdAt: NOW, status: "supported" },
  ]);
  const inputs = { briefId: "b", beliefs, lineage: [node("vl-001", null, cls())], triedCombinations: [], now: NOW };

  it("explores everything when it knows nothing", () => {
    expect(exploreRatio(0)).toBe(1);
    expect(exploreRatio(3)).toBeLessThan(1);
    // Never stops exploring, however much it has learned.
    expect(exploreRatio(10_000)).toBe(0.2);
  });

  it("will not fabricate an exploitation brief with no evidence", () => {
    expect(exploitBrief({ ...inputs, beliefs: [] }, product)).toBeNull();
  });

  it("builds an exploitation brief that cites its evidence and changes one axis", () => {
    const brief = exploitBrief(inputs, product)!;
    expect(brief.strategy).toBe("exploit");
    expect(brief.evidenceCited.join(" ")).toMatch(/hookType=document_reveal/);
    expect(brief.disconfirming).toBeTruthy();
    expect(brief.production.aspectRatio).toBe("9:16");
    expect(brief.production.storyboard.length).toBeGreaterThan(0);
  });

  it("builds an exploration brief that does not pretend to be a controlled test", () => {
    const brief = exploreBrief(inputs, product)!;
    expect(brief.strategy).toBe("explore");
    expect(brief.evidenceCited).toEqual([]);
    expect(brief.disconfirming).toMatch(/cannot fail/);
  });

  it("only offers untested values on the frontier", () => {
    const untested = untestedValues(beliefs, "hookType");
    expect(untested).not.toContain("document_reveal");
    expect(untested).not.toContain("question");
    expect(untested).not.toContain("unknown");
  });

  it("reports the split and names what it is avoiding", () => {
    const discouraging = buildBeliefs([
      { hypothesisId: "h1", statement: "", axis: "hookType", from: "question", to: "document_reveal", controlCreativeId: "c", variantCreativeId: "v", observedLift: 0.4, metric: "ctr", conversions: 30, strength: "supported", caveat: "", confounds: [], createdAt: NOW, status: "supported" },
      { hypothesisId: "h2", statement: "", axis: "hookType", from: "question", to: "curiosity_gap", controlCreativeId: "c", variantCreativeId: "v", observedLift: 0.3, metric: "ctr", conversions: 30, strength: "supported", caveat: "", confounds: [], createdAt: NOW, status: "supported" },
    ]);
    const batch = generateBriefBatch({ ...inputs, beliefs: discouraging }, product, 4);
    expect(batch.briefs.length).toBeGreaterThan(0);
    expect(batch.avoided.some((a) => a.value === "question")).toBe(true);
    expect(batch.note).toMatch(/exploration/);
  });
});

describe("generation queue", () => {
  const product = { name: "BPC-157", landingPath: "/coa-library" };
  const brief = exploreBrief({ briefId: "b1", beliefs: [], lineage: [], triedCombinations: [], now: NOW }, product)!;

  it("assigns a creative id before any provider is called", () => {
    const job = queueGeneration({ jobId: "j1", brief, creativeId: "vl-new-001", provider: "higgsfield", now: NOW });
    expect(job.creativeId).toBe("vl-new-001");
    expect(job.providerJobId).toBeNull();
    expect(job.status).toBe("briefed");
  });

  it("cancels a non-compliant brief before spending a render on it", () => {
    const bad = { ...brief, production: { ...brief.production, hook: "Guaranteed to heal you fast" } };
    const job = queueGeneration({ jobId: "j2", brief: bad, creativeId: "vl-new-002", provider: "higgsfield", now: NOW });
    expect(job.status).toBe("cancelled");
    expect(job.compliance?.approvable).toBe(false);
    expect(() => advanceJob(job, "generating", {}, NOW)).toThrow(/compliance gate/);
  });

  it("refuses to mark a job generated with no asset", () => {
    const job = queueGeneration({ jobId: "j3", brief, creativeId: "vl-new-003", provider: "higgsfield", now: NOW });
    expect(() => advanceJob(job, "generated", {}, NOW)).toThrow(/fabricate a result/);
    const done = advanceJob(job, "generated", { assetPaths: ["/assets/a.mp4"] }, NOW);
    expect(done.status).toBe("generated");
  });
});
