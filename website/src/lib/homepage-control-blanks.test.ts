import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/lib/admin-control.ts"), "utf8");
const homepage = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

// ---------------------------------------------------------------------------
// From a screen recording of the live site opened through a TikTok bio link:
// the hero rendered its "Research Use Only" eyebrow and both CTA buttons, with
// nothing at all between them — no headline, no subheadline.
//
// The markup was never missing. Every consumer writes `control.x ?? "default"`,
// and `??` does not fire on "". A homepage field saved blank in the admin
// therefore beat the designed copy and rendered an empty <h1>.
// ---------------------------------------------------------------------------

describe("a blank homepage control field falls back to the designed copy", () => {
  it("normalises blank strings to undefined before they reach the page", () => {
    // The whole point: "" and "   " must not survive as values.
    expect(source).toMatch(/function text\(value: unknown\): string \| undefined/);
    expect(source).toMatch(/const trimmed = value\.trim\(\);/);
    expect(source).toMatch(/return trimmed\.length > 0 \? trimmed : undefined;/);
  });

  it("routes every homepage copy field through it", () => {
    // A field that skips the helper silently reintroduces the blank-wins bug.
    for (const field of [
      "heroKicker",
      "heroHeadline",
      "heroSubheadline",
      "promoCaption",
      "qualityPanelTitle",
    ]) {
      expect(source, `${field} must be normalised, not passed through raw`)
        .toMatch(new RegExp(`${field}: text\\(homepage\\.`));
    }
  });

  it("leaves the designed defaults in place for the page to fall back to", () => {
    expect(homepage).toContain('control.heroHeadline ?? "Precision, in every vial."');
    expect(homepage).toMatch(/control\.heroSubheadline \?\? "Vanta Labs sources/);
  });
});
