import { describe, expect, it } from "vitest";
import { findCopyComplianceIssue } from "@/lib/email/copy-compliance";

// ---------------------------------------------------------------------------
// THE BRAND'S OWN COPY RULES, MADE ENFORCEABLE RATHER THAN ASPIRATIONAL.
//
// `.claude/skills/vanta-creative-director/references/brand.md` states the
// voice in one line — "No hype, no stacked adjectives, no emojis, no
// exclamation marks" — and compliance.md repeats the prohibition. It was
// written down and nothing checked it, so the highest-volume lifecycle email
// in the system shipped with the headline:
//
//     RESEARCH. TESTED. TRANSPARENT 🧪
//
// to 54 recipients, at the worst open rate of any message the store sends
// (20.4%). An emoji in a subject line is also a mild spam signal, so the rule
// was costing deliverability as well as voice.
//
// SCOPE, DELIBERATELY NARROW. This checks the two things the brand states
// absolutely and that a machine can decide without judgement. "No hype" is
// real and is a human's call — encoding a banned-words list would produce
// false refusals on legitimate copy, which teaches operators to route around
// the check. A rule that fires only when it is certainly right is one people
// trust.
// ---------------------------------------------------------------------------

describe("copy compliance", () => {
  it("rejects the emoji that actually shipped", () => {
    const issue = findCopyComplianceIssue("RESEARCH. TESTED. TRANSPARENT 🧪");
    expect(issue).toBeTruthy();
    expect(issue).toContain("emoji");
  });

  it.each(["🧪", "🚀 Big news", "Save now 💰", "✅ Verified", "Order today ❗"])(
    "rejects %s",
    (text) => {
      expect(findCopyComplianceIssue(text)).toBeTruthy();
    },
  );

  it("rejects an exclamation mark", () => {
    const issue = findCopyComplianceIssue("Your cart is saved!");
    expect(issue).toBeTruthy();
    expect(issue).toContain("exclamation");
  });

  it("accepts the compliant rewrite", () => {
    expect(findCopyComplianceIssue("Read the report first")).toBeNull();
    expect(findCopyComplianceIssue("Search any batch before you order")).toBeNull();
  });

  it.each([
    "Every batch has a published report",
    "Batch VL-BPC-0826. Tested 4 August. The full report is on the site.",
    "10% off with code SAVE-3CA352BA5D",
    "Your GLP-3 is still in your cart",
    "Questions? Reply to this message.",
  ])("accepts real store copy: %s", (text) => {
    expect(findCopyComplianceIssue(text)).toBeNull();
  });

  // PUNCTUATION THAT IS NOT AN EXCLAMATION MARK MUST PASS. A check that fired
  // on ordinary writing would be turned off within a week.
  it.each(["A question? Yes.", "Semi; colon", "Dash — here", "Ratio 1:1", "100% tested batches"])(
    "does not fire on ordinary punctuation: %s",
    (text) => {
      expect(findCopyComplianceIssue(text)).toBeNull();
    },
  );

  it("treats empty and missing copy as compliant, since emptiness is a separate rule", () => {
    expect(findCopyComplianceIssue("")).toBeNull();
    expect(findCopyComplianceIssue(null)).toBeNull();
    expect(findCopyComplianceIssue(undefined)).toBeNull();
  });

  it("finds an emoji anywhere in a long body, not only at the start", () => {
    const body = "Thanks for joining Vanta Labs.\n\nOrders ship tracked.\n\nSee you soon 👋";
    expect(findCopyComplianceIssue(body)).toBeTruthy();
  });

  // Accented characters, symbols and non-Latin scripts are ordinary text, not
  // emoji. Over-blocking here would refuse legitimate product and place names.
  it.each(["Café", "Ångström", "±0.5", "50µg reference", "N-terminal"])(
    "does not mistake %s for an emoji",
    (text) => {
      expect(findCopyComplianceIssue(text)).toBeNull();
    },
  );
});
