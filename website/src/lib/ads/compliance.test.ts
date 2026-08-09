import { describe, expect, it } from "vitest";
import { assertApprovable, reviewConcept, summariseFindings, type ConceptForReview } from "./compliance";
import {
  AXES,
  classify,
  completeness,
  mostInformativeAxis,
  performanceByAttribute,
  type CreativeClassification,
} from "./taxonomy";

const NOW = "2026-08-09T00:00:00Z";

const clean: ConceptForReview = {
  creativeId: "vl-doc-001",
  hook: "Search your lot number.",
  script: "VO: Batch VL-BPC-0826. The full report is on the site.",
  caption: "the report is on the site",
  cta: "Search your lot number",
  visualDirection: "Macro push across a printed report on a dark field",
  claimsUsed: [{ claim: "Batch VL-BPC-0826", source: "published COA, coa_records id 41" }],
};

describe("compliance gate — hard prohibitions", () => {
  const blocks: [string, Partial<ConceptForReview>][] = [
    ["human use, second person", { hook: "Ready to see your results?" }],
    ["administration", { script: "VO: inject once and wait" }],
    ["dosing with a schedule", { caption: "250mcg per day for eight weeks" }],
    ["protocol language", { script: "VO: an eight week cycle length" }],
    ["reconstitution", { script: "VO: reconstitute with bacteriostatic water" }],
    ["medical claim", { hook: "It heals faster." }],
    ["body composition", { caption: "serious muscle gain" }],
    ["guaranteed outcome", { hook: "Guaranteed to work." }],
    ["transformation", { caption: "before and after, 30 days" }],
    ["fabricated social proof", { caption: "4.9 stars from 2,000 reviews" }],
    ["unverified certification", { hook: "GMP certified and FDA approved" }],
    ["moderation evasion", { caption: "premium p3ptides in stock" }],
  ];

  for (const [label, patch] of blocks) {
    it(`blocks ${label}`, () => {
      const verdict = reviewConcept({ ...clean, ...patch });
      expect(verdict.status, label).toBe("BLOCK");
      expect(verdict.approvable).toBe(false);
      expect(verdict.findings.some((f) => f.severity === "block")).toBe(true);
    });
  }

  it("passes a clean documentation-led concept", () => {
    const verdict = reviewConcept(clean);
    expect(verdict.status).toBe("PASS");
    expect(verdict.findings).toEqual([]);
    expect(verdict.approvable).toBe(true);
  });

  it("names the field and quotes the exact text, never a paraphrase", () => {
    const verdict = reviewConcept({ ...clean, caption: "It cures inflammation" });
    const finding = verdict.findings.find((f) => f.ruleId === "claim/medical")!;
    expect(finding.field).toBe("caption");
    expect(finding.matched.toLowerCase()).toBe("cures");
    expect(finding.remedy).toBeTruthy();
  });

  it("checks on-screen text, which is where claims usually hide", () => {
    const verdict = reviewConcept({ ...clean, onScreenText: ["99.9% PURITY", "CLINICALLY PROVEN"] });
    expect(verdict.status).toBe("BLOCK");
    expect(verdict.findings.map((f) => f.field)).toContain("onScreenText[1]");
  });
});

describe("compliance gate — substantiation", () => {
  it("blocks a purity figure with no recorded source", () => {
    const verdict = reviewConcept({ ...clean, onScreenText: ["99.2% purity"], claimsUsed: [] });
    expect(verdict.status).toBe("BLOCK");
    expect(verdict.findings.some((f) => f.ruleId === "substantiation/purity")).toBe(true);
  });

  it("blocks when the source is a placeholder rather than a document", () => {
    for (const source of ["TBD", "n/a", "pending", "assumed", "  "]) {
      const verdict = reviewConcept({ ...clean, onScreenText: ["99.2% purity"], claimsUsed: [{ claim: "purity", source }] });
      expect(verdict.status, source).toBe("BLOCK");
    }
  });

  it("allows the same figure when a real document is recorded", () => {
    const verdict = reviewConcept({
      ...clean,
      onScreenText: ["99.2% purity"],
      claimsUsed: [{ claim: "99.2% purity", source: "published COA for batch VL-BPC-0826" }],
    });
    expect(verdict.status).toBe("PASS");
  });

  it("catches a blanket third-party testing claim", () => {
    const verdict = reviewConcept({ ...clean, caption: "third-party tested", claimsUsed: [] });
    expect(verdict.findings.some((f) => f.ruleId === "substantiation/third-party")).toBe(true);
  });
});

describe("compliance gate — softer signals", () => {
  it("flags brand-voice slips for review without blocking", () => {
    const verdict = reviewConcept({ ...clean, caption: "the report is on the site!" });
    expect(verdict.status).toBe("REVIEW");
    expect(verdict.approvable).toBe(true);
    expect(verdict.findings[0].ruleId).toBe("voice/exclamation");
  });

  it("flags manufactured urgency for a human to confirm against the live store", () => {
    const verdict = reviewConcept({ ...clean, caption: "only 3 left" });
    expect(verdict.status).toBe("REVIEW");
  });

  it("does not fire on ordinary words that merely contain a keyword", () => {
    const verdict = reviewConcept({
      ...clean,
      script: "VO: the material is dosed into the chromatography column during analysis",
      caption: "a curated catalogue",
    });
    expect(verdict.findings.map((f) => f.ruleId)).not.toContain("claim/medical");
    expect(verdict.status).toBe("PASS");
  });

  it("does not treat ordinary laboratory language as a lab attribution", () => {
    // Regression: the rule used /i, so the capital-letter requirement did
    // nothing and "dark matte laboratory field" tripped a substantiation block.
    const verdict = reviewConcept({ ...clean, visualDirection: "dark matte laboratory field, lit from behind" });
    expect(verdict.status).toBe("PASS");
  });

  it("still catches an actual named-lab attribution", () => {
    const verdict = reviewConcept({ ...clean, caption: "analysed by Janoshik", claimsUsed: [] });
    expect(verdict.findings.some((f) => f.ruleId === "substantiation/lab")).toBe(true);
  });

  it("treats a vial size as a specification, not a dose", () => {
    expect(reviewConcept({ ...clean, onScreenText: ["5mg vial"] }).status).toBe("PASS");
  });
});

describe("the gate itself", () => {
  it("throws on a blocked concept so it cannot be ignored", () => {
    expect(() => assertApprovable({ ...clean, hook: "Guaranteed to work" })).toThrow(/cannot be approved/);
  });

  it("returns the verdict for anything approvable", () => {
    expect(assertApprovable(clean).status).toBe("PASS");
    expect(assertApprovable({ ...clean, caption: "hurry" }).status).toBe("REVIEW");
  });

  it("summarises which rule causes the most rework", () => {
    const verdicts = [
      reviewConcept({ ...clean, hook: "It heals" }),
      reviewConcept({ ...clean, caption: "treatment for recovery" }),
      reviewConcept({ ...clean, caption: "only 2 left" }),
    ];
    const summary = summariseFindings(verdicts);
    expect(summary[0].ruleId).toBe("claim/medical");
    expect(summary[0].count).toBeGreaterThanOrEqual(2);
  });
});

describe("creative taxonomy", () => {
  it("accepts known terms and normalises spacing and case", () => {
    const { classification, rejected } = classify(
      { hookType: "Document Reveal", visualStyle: "cinematic-macro", pacing: "SLOW" },
      "human",
      NOW,
    );
    expect(classification.hookType).toBe("document_reveal");
    expect(classification.visualStyle).toBe("cinematic_macro");
    expect(classification.pacing).toBe("slow");
    expect(rejected).toEqual([]);
  });

  it("rejects invented terms rather than letting the vocabulary drift", () => {
    const { classification, rejected } = classify({ hookType: "vibes based opener" }, "model", NOW);
    expect(classification.hookType).toBe("unknown");
    expect(rejected).toEqual([{ axis: "hookType", value: "vibes based opener" }]);
  });

  it("leaves unspecified axes unknown rather than guessing", () => {
    const { classification } = classify({ hookType: "question" }, "model", NOW);
    expect(classification.visualStyle).toBe("unknown");
    expect(completeness(classification)).toBeCloseTo(1 / Object.keys(AXES).length, 2);
  });

  it("records who classified it", () => {
    expect(classify({}, "heuristic", NOW).classification.classifiedBy).toBe("heuristic");
  });
});

function classified(patch: Partial<CreativeClassification>): CreativeClassification {
  return { ...classify({}, "human", NOW).classification, ...patch };
}

describe("attribute correlation", () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      creativeId: `doc-${i}`,
      classification: classified({ hookType: "document_reveal" }),
      spend: 100, purchases: 3, revenue: 400,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      creativeId: `claim-${i}`,
      classification: classified({ hookType: "bold_claim" }),
      spend: 100, purchases: 2, revenue: 120,
    })),
    // Deliberately tiny bucket with a spectacular return.
    { creativeId: "fluke-1", classification: classified({ hookType: "negative" }), spend: 10, purchases: 1, revenue: 900 },
  ];

  it("groups return by attribute", () => {
    const byHook = performanceByAttribute(rows, "hookType");
    const doc = byHook.find((g) => g.value === "document_reveal")!;
    expect(doc.creatives).toBe(6);
    expect(doc.roas).toBeCloseTo(4, 5);
  });

  it("refuses to let a two-creative fluke top the leaderboard", () => {
    const byHook = performanceByAttribute(rows, "hookType");
    const fluke = byHook.find((g) => g.value === "negative")!;
    expect(fluke.roas).toBe(90);
    expect(fluke.sufficient).toBe(false);
    // Ranked below the well-evidenced buckets despite a 90x return.
    expect(byHook[0].value).toBe("document_reveal");
    expect(byHook.indexOf(fluke)).toBeGreaterThan(1);
  });

  it("finds the axis that currently explains the most variation", () => {
    const best = mostInformativeAxis(rows);
    expect(best?.axis).toBe("hookType");
    expect(best?.buckets).toBe(2);
    expect(best?.spread).toBeCloseTo(4 - 1.2, 5);
  });

  it("returns nothing when no axis has two well-evidenced buckets", () => {
    expect(mostInformativeAxis(rows.slice(-1))).toBeNull();
  });
});
