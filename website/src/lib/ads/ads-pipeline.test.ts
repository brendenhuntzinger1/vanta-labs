import { describe, expect, it } from "vitest";

import { applyAnalysis, buildAnalysisJobs, ingestBulk, parseLine, tasteProfile } from "./reference-ingest";
import {
  HiggsfieldProvider,
  TIKTOK_FRAME,
  extractSpokenLines,
  planMedia,
  reviewGate,
  type RenderJob,
} from "./media-provider";
import type { VantaCreative } from "./types";

const NOW = "2026-08-09T12:00:00Z";

describe("bulk reference ingestion", () => {
  it("parses the shapes an owner actually types", () => {
    const paste = `
https://www.tiktok.com/@brand/video/1 — love the lighting, hate the text
Ridge Wallet | https://www.tiktok.com/@ridge/video/2 | the hook is the whole ad
https://www.instagram.com/reel/xyz
# a comment, ignored

this one I only remember describing, no link, the pacing was frenetic
`.trim();

    const result = ingestBulk(paste, NOW);
    expect(result.references).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);

    const [first, second, third, described] = result.references;
    expect(first.source.platform).toBe("tiktok");
    expect(first.ownerNote).toContain("love the lighting");
    expect(second.source.company).toBe("Ridge Wallet");
    expect(second.ownerNote).toContain("hook is the whole ad");
    expect(third.source.platform).toBe("reels");
    expect(described.source.kind).toBe("described");
  });

  it("does not let one bad line lose the batch", () => {
    const result = ingestBulk("https://www.tiktok.com/@a/video/1 — good\n   \nhttps://www.tiktok.com/@b/video/2", NOW);
    expect(result.references).toHaveLength(2);
  });

  it("collapses duplicates within a batch and against the library", () => {
    const existing = ingestBulk("https://www.tiktok.com/@a/video/1", NOW).references;
    const again = ingestBulk(
      "https://www.tiktok.com/@a/video/1 — second time I sent this\nhttps://www.tiktok.com/@b/video/9",
      NOW,
      existing,
    );
    expect(again.references).toHaveLength(1);
    expect(again.duplicates).toHaveLength(1);
    expect(again.duplicates[0].referenceId).toBe(existing[0].referenceId);
  });

  it("scales to a large paste", () => {
    const paste = Array.from({ length: 500 }, (_, i) => `https://www.tiktok.com/@brand/video/${i} — note ${i}`).join("\n");
    const result = ingestBulk(paste, NOW);
    expect(result.references).toHaveLength(500);
    expect(new Set(result.references.map((r) => r.referenceId)).size).toBe(500);
  });

  it("queues everything unobserved for an analysis pass", () => {
    const result = ingestBulk("https://www.tiktok.com/@a/video/1 — nice", NOW);
    expect(result.needsAnalysis).toEqual([result.references[0].referenceId]);

    const jobs = buildAnalysisJobs(result.references);
    expect(jobs[0].input).toEqual({ kind: "url", url: "https://www.tiktok.com/@a/video/1" });
    expect(jobs[0].fields).toContain("hook");
    // The instruction must forbid producing a rewrite of the source ad.
    expect(jobs[0].instruction).toMatch(/do not rewrite it/i);
    expect(jobs[0].instruction).toMatch(/doNotCopy/);
  });

  it("marks a reference with no url and no asset as unanalysable rather than guessing", () => {
    const refs = ingestBulk("just a thing I saw once with really fast cuts", NOW).references;
    expect(buildAnalysisJobs(refs)[0].input).toEqual({ kind: "unavailable" });
  });
});

describe("analysis merge — the owner's note wins", () => {
  const base = ingestBulk("https://www.tiktok.com/@a/video/1 — this looks cheap", NOW).references[0];

  it("keeps the owner's verdict when the analyser disagrees", () => {
    const merged = applyAnalysis(
      base,
      {
        referenceId: base.referenceId,
        observed: { visualStyle: "lavish high-budget cinematic", format: "cinematic" },
        whyItMayWork: "production value signals legitimacy",
      },
      NOW,
    );
    expect(merged.observed.visualStyle).toBe("lavish high-budget cinematic");
    // …and the owner still says it looks cheap. That is the signal that steers
    // generation, not the analyser's adjective.
    expect(merged.ownerVerdict?.find((s) => s.dimension === "quality_bar")?.sentiment).toBe("dislike");
  });

  it("accumulates do-not-copy and compliance flags without duplicating", () => {
    const once = applyAnalysis(base, { referenceId: base.referenceId, observed: {}, doNotCopy: ["mascot"], complianceFlags: ["before/after"] }, NOW);
    const twice = applyAnalysis(once, { referenceId: base.referenceId, observed: {}, doNotCopy: ["mascot", "jingle"] }, NOW);
    expect(twice.doNotCopy).toEqual(["mascot", "jingle"]);
    expect(twice.complianceFlags).toEqual(["before/after"]);
  });

  it("builds a taste profile weighted by strength of feeling", () => {
    const refs = [
      ingestBulk("https://www.tiktok.com/@a/video/1 — I love the lighting", NOW).references[0],
      ingestBulk("https://www.tiktok.com/@b/video/2 — the lighting here is great too", NOW).references[0],
      ingestBulk("https://www.tiktok.com/@c/video/3 — this looks cheap", NOW).references[0],
    ];
    const profile = tasteProfile(refs);
    const quality = profile.find((p) => p.dimension === "quality_bar");
    expect(quality?.net).toBeLessThan(0);
    expect(profile.find((p) => p.dimension === "lighting")?.net).toBeGreaterThan(0);
  });

  it("reads a bare line with no separator", () => {
    expect(parseLine("https://www.tiktok.com/@a/video/1", 1).intake?.url).toBe("https://www.tiktok.com/@a/video/1");
    expect(parseLine("", 1).intake).toBeUndefined();
    expect(parseLine("# note", 1).intake).toBeUndefined();
  });
});

function creative(overrides: Partial<VantaCreative> = {}): VantaCreative {
  return {
    creativeId: "vl-doc-001",
    conceptId: "concept-doc",
    variantOf: null,
    variantAxis: "none",
    archetype: "documentation",
    status: "concept",
    createdAt: NOW,
    hook: "Search your lot number.",
    openingFrame: "A batch report on a dark field, lit from behind",
    script: "VO: Batch VL-BPC-0826.\nON-SCREEN: VL-BPC-0826\nVO: The full report is on the site.",
    storyboard: [
      { index: 1, durationSeconds: 2, description: "Macro push across a printed report", cameraNote: "slow dolly", lightingNote: "single key from behind" },
      { index: 2, durationSeconds: 4, description: "Vial rotating on a dark field", cameraNote: "locked off" },
    ],
    caption: "the report is on the site",
    cta: "Search your lot number",
    landingPath: "/coa-library",
    audienceHypothesis: "buyers who verify",
    lengthSeconds: 9,
    claimsUsed: [],
    eligibility: "needs_verification",
    inspiredByReferenceIds: [],
    usesPatternIds: [],
    mediaRequests: [],
    platformRefs: null,
    ...overrides,
  };
}

describe("media pipeline", () => {
  const provider = new HiggsfieldProvider();

  it("plans one 9:16 job per shot, plus an opening frame and a voiceover", () => {
    const jobs = provider.plan(creative());
    const kinds = jobs.map((j) => `${j.kind}:${j.requestId}`);
    expect(kinds).toEqual([
      "video:vl-doc-001-shot-1",
      "video:vl-doc-001-shot-2",
      "image:vl-doc-001-openframe",
      "voiceover:vl-doc-001-vo",
    ]);
    for (const job of jobs) {
      expect(job.aspect).toBe("9:16");
      expect(job.width).toBe(TIKTOK_FRAME.width);
      expect(job.height).toBe(TIKTOK_FRAME.height);
      expect(job.creativeId).toBe("vl-doc-001");
    }
  });

  it("conditions every prompt on the brand and blocks the compliance failures", () => {
    const jobs = provider.plan(creative());
    for (const job of jobs.filter((j) => j.kind !== "voiceover")) {
      expect(job.prompt).toContain("#0a0a0a");
      expect(job.prompt).toContain("#c7ae5e");
      for (const forbidden of ["human body", "syringe entering skin", "before and after", "purity percentage text", "glowing blue liquid"]) {
        expect(job.avoid).toContain(forbidden);
      }
    }
  });

  it("sends only the spoken lines to the voice model", () => {
    const vo = provider.plan(creative()).find((j) => j.kind === "voiceover")!;
    expect(vo.voice?.script).toBe("Batch VL-BPC-0826. The full report is on the site.");
    expect(vo.voice?.script).not.toContain("ON-SCREEN");
    expect(extractSpokenLines("ON-SCREEN: nothing spoken here")).toBe("");
  });

  it("omits the voiceover job entirely when a concept has no spoken lines", () => {
    const silent = creative({ script: "ON-SCREEN: VL-BPC-0826" });
    expect(provider.plan(silent).some((j) => j.kind === "voiceover")).toBe(false);
  });

  it("refuses to plan a creative with no storyboard", () => {
    expect(() => provider.plan(creative({ storyboard: [] }))).toThrow(/no storyboard/);
  });

  it("binds every asset to a permanent creative id before generation", () => {
    const requests = planMedia(creative(), provider);
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => r.provider === "higgsfield" && r.status === "pending")).toBe(true);
    expect(() => planMedia(creative({ creativeId: "" }), provider)).toThrow(/unattributable/);
  });

  it("says it cannot render rather than pretending it did", async () => {
    const job = provider.plan(creative())[0];
    const outcome = await provider.dispatch(job);
    expect(outcome.status).toBe("unavailable");
    expect(outcome.assetPath).toBeUndefined();
    expect(outcome.error).toMatch(/transport/);
  });

  it("uses an injected transport when one exists", async () => {
    const seen: RenderJob[] = [];
    const wired = new HiggsfieldProvider(async (job) => {
      seen.push(job);
      return { requestId: job.requestId, status: "complete", provider: "higgsfield", assetPath: `/assets/${job.requestId}.mp4` };
    });
    const outcome = await wired.dispatch(wired.plan(creative())[0]);
    expect(outcome.status).toBe("complete");
    expect(outcome.assetPath).toContain("vl-doc-001-shot-1");
    expect(seen).toHaveLength(1);
  });

  it("holds a creative back until every asset exists, and always needs a human", () => {
    const pending = creative({ mediaRequests: [{ requestId: "r1", kind: "video", prompt: "p", status: "pending" }] });
    const gate = reviewGate(pending);
    expect(gate.ready).toBe(false);
    expect(gate.missing[0]).toContain("r1");
    expect(gate.requiresHumanApproval).toBe(true);

    const done = creative({
      mediaRequests: [{ requestId: "r1", kind: "video", prompt: "p", status: "complete", assetPath: "/a.mp4" }],
    });
    expect(reviewGate(done).ready).toBe(true);
    expect(reviewGate(done).requiresHumanApproval).toBe(true);
  });
});
