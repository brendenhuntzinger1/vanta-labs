import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseSegmentRule } from "@/lib/email/segment-rules";

// ---------------------------------------------------------------------------
// TWO MARKETING DEFECTS, OPPOSITE IN DIRECTION: ONE COULD NEVER SEND TO THE
// RIGHT PEOPLE, THE OTHER COULD SEND TO THE WRONG ONES.
//
// 1. NO CAMPAIGN AUDIENCE RULE COULD EVER BE SAVED.
//
// segment_param carries two different things. For most segments it is a short
// scalar — a category slug — and the 80-character cap is generous. For segment
// "rule" it holds the audience rule's JSON, and 80 characters is not tight, it
// is impossible: the SMALLEST rule the parser will accept — one group, one
// condition, one filter — serialises to 115 characters. Every rule was cut
// mid-token into invalid JSON, so parseSegmentRule returned null and the
// audience resolved to nobody.
//
// The cap dates from when the column only ever held a category slug, and was
// never revisited when the rule feature started sharing it. So the
// custom-audience builder has never worked: a create was refused with a message
// the operator could not act on, and an edit silently stored a rule selecting
// no one, ending as a campaign whose recipient count is zero.
//
// An unreadable rule is now also refused at SAVE time rather than at send time,
// where the only symptom is a campaign that reached nobody.
//
// 2. THE SUPPRESSION RE-CHECK FAILED OPEN.
//
// sendRenderedMarketingEmail is reachable directly from the queue drain, so it
// re-checks suppression. The choke point it duplicates fails CLOSED, under a
// comment explaining why. The re-check destructured only `data` and dropped
// `error`, so an unreadable suppression table was indistinguishable from "not
// suppressed" and the send went out — the single outcome the module exists to
// prevent, whose worst variant is mailing someone who pressed "report spam".
//
// The asymmetry is the argument: marketing has a retry queue and a next tick,
// so refusing costs a delay, while a send to a suppressed address cannot be
// taken back.
// ---------------------------------------------------------------------------

const adminEmail = readFileSync(resolve(process.cwd(), "src/lib/admin-email.ts"), "utf8");
const marketing = readFileSync(resolve(process.cwd(), "src/lib/email/marketing.ts"), "utf8");

describe("an audience rule fits in the column that holds it", () => {
  // The smallest rule the builder can actually emit, in the shape the parser
  // accepts: groups -> conditions -> filters. Built here rather than invented,
  // because the whole measurement below rests on it being a REAL rule — a first
  // draft of this test used a plausible-looking but invalid shape, which the
  // parser rejected whole and truncated alike, and would have "passed" for the
  // wrong reason.
  const smallestRealRule = JSON.stringify({
    groups: [{ conditions: [{ junction: "and", filters: [{ field: "orderCount", operator: "moreThan", value: 1 }] }] }],
  });

  it("is a rule this codebase's own parser accepts", () => {
    expect(parseSegmentRule(smallestRealRule)).not.toBeNull();
  });

  it("does not fit in the 80 characters the column allowed", () => {
    // If the rule format ever gets smaller than the old cap, this says so
    // rather than quietly passing.
    expect(smallestRealRule.length).toBeGreaterThan(80);
  });

  it("is unreadable once truncated, which is why no rule could ever be saved", () => {
    expect(parseSegmentRule(smallestRealRule.slice(0, 80))).toBeNull();
  });

  it("gives the rule its own budget and keeps the scalar cap for everything else", () => {
    expect(adminEmail).toContain('text(input.segmentParam, segment === "rule" ? 8000 : 80)');
    expect(adminEmail).not.toContain("text(input.segmentParam, 80)");
  });

  it("refuses an unreadable rule at save time rather than at send time", () => {
    expect(adminEmail).toContain('if (segment === "rule" && !parseSegmentRule(segmentParam))');
  });
});

describe("consent that cannot be verified is not consent", () => {
  it("the queue-drain re-check reads the error rather than only the row", () => {
    expect(marketing).toContain("const { data: suppressed, error: suppressionError } = await supabaseAdmin");
  });

  it("refuses the send when the suppression list cannot be read", () => {
    // Both the choke point and the re-check must carry this. Two occurrences.
    const refusals = marketing.split("Suppression list unavailable; consent could not be verified").length - 1;
    expect(refusals).toBe(2);
  });

  it("still refuses a genuinely suppressed address", () => {
    expect(marketing).toContain("Recipient has unsubscribed from marketing emails");
  });

  it("releases the send-once claim on every refusal, so a later tick can retry", () => {
    // A claimed-but-unreleased slot is a message that can never be sent again.
    const releases = marketing.split("await releaseHeldClaim(input.claimedLogId);").length - 1;
    expect(releases).toBeGreaterThanOrEqual(5);
  });
});
