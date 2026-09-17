import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE SHAPE THAT SHIPPED A BROKEN SENTENCE TO PRODUCTION.
//
// On 2026-09-16 the store's welcome-offer sentence was written this way:
//
//     `Subscribe to texts for ${WELCOME_OFFER_PERCENT}% off your first order. `
//     + `Valid for ${WELCOME_OFFER_DAYS} days. Cannot be combined...`
//
// Vitest asserted the exact string and passed. The dev server rendered it
// correctly. The MINIFIED bundle shipped:
//
//     "Subscribe to texts for 15Valid for 14 days. Cannot be combined..."
//
// The folder collapsed the pair and dropped the first template's trailing
// quasi — here, "% off your first order. ", which was the entire offer. Four
// customer-facing surfaces carried it.
//
// IT ONLY BITES WHEN EVERY SUBSTITUTION IS A COMPILE-TIME CONSTANT, because
// only then is the pair foldable at all. That is precisely what a copy module
// is made of, and it is why no unit test could catch it: nothing in a test run
// is minified. The two other places in this repository with the same syntax
// interpolate runtime values (`campaign.sent`, `batch.orderCount`), so they
// are left whole and are deliberately not flagged here.
//
// WHY A SOURCE SCAN RATHER THAN A BUNDLE CHECK. There is a bundle check beside
// this one (welcome-offer-placements.test.ts), and it is worth having, but CI
// runs `npx vitest run` with no `next build` — so there are no chunks there and
// it skips. A skip that reads as a pass is the exact failure this repository's
// own CI workflow was written to prevent. This scan needs no build and so
// actually runs on every pull request.
//
// The rule: never concatenate two template literals whose substitutions are
// all compile-time constants. Write each as its own constant and join the
// identifiers, which is what welcome-offer-copy.ts now does.
// ---------------------------------------------------------------------------

/** A `${…}` whose contents are a bare SCREAMING_CASE identifier: a module constant by convention. */
const CONSTANT_SUBSTITUTION = /^\$\{\s*[A-Z][A-Z0-9_]*\s*\}$/;

/**
 * A template literal immediately added to another template literal. Numbered
 * groups rather than named ones: this project's tsconfig targets below ES2018,
 * where named groups are a compile error.
 */
const TEMPLATE_PAIR = /`([^`\\]*(?:\\.[^`\\]*)*)`\s*\+\s*`([^`\\]*(?:\\.[^`\\]*)*)`/g;

function substitutions(quasi: string): string[] {
  return quasi.match(/\$\{[^}]*\}/g) ?? [];
}

/** Does this template literal end in text AFTER its last substitution? That tail is what gets lost. */
function hasTailAfterSubstitution(quasi: string): boolean {
  const last = quasi.lastIndexOf("}");
  if (last === -1 || !quasi.includes("${")) return false;
  return quasi.slice(last + 1).length > 0;
}

function sourceFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "src/**/*.ts", "src/**/*.tsx"],
    { cwd: new URL("../../../", import.meta.url).pathname, encoding: "utf8" },
  );
  return out.split("\n").filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"));
}

describe("no foldable template pair can lose its tail", () => {
  it("finds no constant-only template concatenation anywhere in src", () => {
    const root = new URL("../../../", import.meta.url).pathname;
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      // Test files are never minified, so the shape is harmless there — and
      // this very file quotes it in a comment.
      if (file.includes(".test.")) continue;
      const source = readFileSync(`${root}${file}`, "utf8");
      for (const match of source.matchAll(TEMPLATE_PAIR)) {
        const first = match[1] ?? "";
        const second = match[2] ?? "";
        const all = [...substitutions(first), ...substitutions(second)];
        if (all.length === 0) continue;
        // Runtime values cannot be folded, so the pair survives.
        if (!all.every((s) => CONSTANT_SUBSTITUTION.test(s))) continue;
        // Nothing to lose if the first template ends on its last substitution.
        if (!hasTailAfterSubstitution(first)) continue;
        const line = source.slice(0, match.index ?? 0).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }

    expect(
      offenders,
      "Two template literals added together, with only compile-time constants inside them. "
      + "The minifier folds the pair and drops the first one's trailing text. "
      + "Give each half its own constant and join the identifiers instead.",
    ).toEqual([]);
  });

  it("recognises the shape it is looking for, so an empty result means something", () => {
    // The floor on the scan itself: if the regex ever stops matching, the test
    // above passes vacuously and protects nothing.
    const sample = "const S = `a ${PERCENT}% off. ` + `b ${DAYS} days.`;";
    const found = [...sample.matchAll(TEMPLATE_PAIR)];
    expect(found).toHaveLength(1);
    expect(hasTailAfterSubstitution(found[0][1] ?? "")).toBe(true);
    expect(substitutions(found[0][1] ?? "").every((s) => CONSTANT_SUBSTITUTION.test(s))).toBe(true);
  });

  it("leaves a runtime-valued pair alone", () => {
    const sample = "const S = `Stop \"${campaign.name}\"? ` + `${campaign.pending} left.`;";
    const found = [...sample.matchAll(TEMPLATE_PAIR)];
    expect(found).toHaveLength(1);
    const first = found[0][1] ?? "";
    expect(substitutions(first).every((s) => CONSTANT_SUBSTITUTION.test(s))).toBe(false);
  });

  it("finds the scan a real set of files to read", () => {
    expect(sourceFiles().length).toBeGreaterThan(400);
  });
});
