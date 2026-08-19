import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// The gate is the first thing every visitor meets and the one thing on the site
// that must never be weakened. These guard the fix for two measured problems:
//
//   * a returning visitor saw the "Restricted Access · 21+" panel flash for
//     ~270ms on EVERY page load, because whether they had confirmed lives in
//     localStorage and the gate only removed itself in an effect (after paint);
//   * the scroll lock was applied by that same effect, so on a slow connection
//     the store scrolled behind the overlay until JavaScript arrived.
//
// Both are now resolved before the first paint. The rules below exist so that
// stays true, and so the gate can never be accidentally loosened.
// ---------------------------------------------------------------------------

describe("the age gate resolves before the first paint", () => {
  const layout = read("src/app/layout.tsx");
  const css = read("src/app/globals.css");
  const gate = read("src/components/age-gate.tsx");

  it("writes the answer onto <html> from an inline script, not an effect", () => {
    expect(layout).toContain("data-age-verified");
    expect(layout).toMatch(/<head>/);
    // Must be inline (runs during HTML parsing). A deferred/module script would
    // run after paint and reintroduce the flash.
    expect(layout).toMatch(/<script\s+dangerouslySetInnerHTML/);
    expect(layout).toContain("suppressHydrationWarning");
  });

  it("reads exactly the same two sources, in the same order, as React does", () => {
    // If these ever diverge, the pre-paint answer and React's answer disagree
    // and the gate flickers or shows to someone who already confirmed.
    for (const source of [layout, gate]) {
      expect(source).toContain("vanta-labs-age-verified");
      expect(source).toContain("vl_age_verified");
    }
  });

  it("FAILS CLOSED — only an explicit \"true\" can hide the gate", () => {
    // The CSS must key off ="true", never on the absence of the attribute, so
    // that a thrown error or disabled JavaScript shows the gate.
    expect(css).toMatch(/html\[data-age-verified="true"\]\s*\[data-age-gate\]\s*\{\s*display:\s*none/);
    expect(css).not.toMatch(/html:not\(\[data-age-verified\]\)\s*\[data-age-gate\]/);
    // The inline script's default before any check is "false".
    expect(layout).toMatch(/var v\s*=\s*"false"/);
  });

  it("locks the page behind the gate without waiting for hydration", () => {
    expect(css).toMatch(/html\[data-age-verified="false"\]\s*body\s*\{\s*overflow:\s*hidden/);
  });

  it("keeps the attribute in step with React, so the lock is released on accept", () => {
    // Without this the attribute stays "false" after someone confirms and the
    // CSS lock above would leave the store permanently unscrollable.
    expect(gate).toMatch(/setAttribute\("data-age-verified",\s*isVerified \? "true" : "false"\)/);
  });

  it("still requires all four attestations before entry", () => {
    expect(gate).toContain("const agreed = ATTESTATIONS.every((a) => confirmed[a.id]);");
    expect(gate).toMatch(/disabled=\{!agreed\}/);
    // Four separate statements, not one combined tick.
    const ids = gate.match(/\{\s*id:\s*"/g) ?? [];
    expect(ids.length).toBe(4);
  });

  it("marks the overlay so the pre-paint CSS can find it", () => {
    expect(gate).toContain('data-age-gate="true"');
  });
});
