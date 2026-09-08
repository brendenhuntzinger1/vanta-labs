import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const R = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CAMPAIGN_API = R("src/app/api/admin/email/campaigns/route.ts");
const SENDER = R("src/lib/email/campaign-sender.ts");

// ---------------------------------------------------------------------------
// A RULE IS ONLY WORTH HAVING IF THE SEND PATH USES IT.
//
// The rule rides in `segment_param`, which email-campaigns.sql already
// describes as "free text so a future segment can reuse it without a
// migration" — this is that future segment, and it needs no schema change.
//
// Two places have to agree, and a silent disagreement between them is the
// failure worth guarding: the API, which decides whether a campaign may be
// SAVED, and the sender, which decides who it goes TO. If the API accepts a
// rule the sender cannot read, the campaign sends to nobody; if the sender
// resolves a rule the API never validated, an unparseable rule reaches the
// audience builder — which fails closed, but only by luck rather than design.
// ---------------------------------------------------------------------------

describe("the campaign API validates a rule before storing it", () => {
  it("parses the rule rather than trusting the segment param", () => {
    expect(CAMPAIGN_API).toContain("parseSegmentRule");
  });

  // A rule the engine cannot read must be refused at the boundary, where the
  // operator is standing and can fix it — not at send time, where it silently
  // becomes a campaign that reaches nobody.
  it("rejects an unparseable rule at save time", () => {
    expect(CAMPAIGN_API).toMatch(/parseSegmentRule[\s\S]{0,400}status:\s*400/);
  });
});

describe("the sender resolves the rule it was given", () => {
  it("passes the stored rule into resolveAudience", () => {
    expect(SENDER).toMatch(/resolveAudience\(\{[\s\S]{0,200}rule:/);
  });
});

// ---------------------------------------------------------------------------
// THE CHECK THE SOURCE-LEVEL TESTS ABOVE CANNOT MAKE.
//
// Those assert that the API mentions parseSegmentRule. They do not assert that
// a rule campaign can be SAVED — and it could not: the API gates every campaign
// on isCampaignSegment(), which reads CAMPAIGN_SEGMENTS, and "rule" was added
// to the CampaignSegment type without being added to that array. Every rule
// campaign was rejected with a 400 before the rule was ever looked at.
//
// A test that asserts a symbol is present is not a test that the feature works.
// ---------------------------------------------------------------------------

describe("a rule campaign passes the API's segment gate", () => {
  it("accepts \"rule\" as a segment", async () => {
    const { isCampaignSegment } = await import("@/lib/email/audience");
    expect(isCampaignSegment("rule")).toBe(true);
  });

  it("still rejects a segment nobody defined", async () => {
    const { isCampaignSegment } = await import("@/lib/email/audience");
    expect(isCampaignSegment("everyone_everywhere")).toBe(false);
  });

  it("offers the rule option to the composer, flagged as needing a rule", async () => {
    const { CAMPAIGN_SEGMENTS } = await import("@/lib/email/audience");
    const rule = CAMPAIGN_SEGMENTS.find((segment) => segment.value === "rule");

    expect(rule).toBeDefined();
    expect(rule?.needsRule).toBe(true);
    // It must not also claim to need the category param, or the composer would
    // render a category dropdown beside the rule builder.
    expect(rule?.needsParam).toBeFalsy();
  });
});
