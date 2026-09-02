import { describe, expect, it } from "vitest";

import { checkCampaignDeliverability } from "@/lib/email/deliverability-check";

// ---------------------------------------------------------------------------
// THE GUARD THAT READS A CAMPAIGN BEFORE A MAILBOX PROVIDER DOES.
//
// This store already knows what a filter's verdict costs. On 2026-08-29 a
// signup confirmation was DELIVERED — Resend said so — and still failed,
// because Gmail filed it as spam and spam messages have their links stripped.
// See template-standards.test.ts, which exists for the same reason.
//
// The templates are covered by that file. NOTHING covered the one email whose
// words are typed by hand into a form and sent to the whole list: a campaign.
// The composer accepted any copy at all, so the deliverability of a broadcast
// rested entirely on whoever was typing knowing which phrases mailbox filters
// score against. That is not knowledge an admin panel should assume.
//
// The audit of 2026-09-02 found the draft sitting in production:
//
//     subject   "buy 2 get 1"
//     preheader "exclusive deal"
//     headline  "limited time buy 2 get 1"
//     body      "hurry act fast"
//     code      "b2g1"
//     cta       "SHOP NOW"
//
// Six trigger phrases in seventeen words, and a three-word body wrapped around
// a promo code and a link — the exact thin-promo shape filters score hardest.
// Every automation that IS delivering cleanly ("How's your research going?",
// "Still researching?") carries none of it. The infrastructure was never the
// difference. The copy was.
//
// THIS IS A HEURISTIC, AND IT SAYS SO. No local check can predict Gmail's
// verdict, and this one does not claim to. It reports the signals that are
// well documented, cheap to detect and actionable by the person typing —
// nothing more. A clean report is not a promise of the inbox; a bad one is a
// reliable sign of trouble.
// ---------------------------------------------------------------------------

/** The campaign found in production during the 2026-09-02 audit. */
const AUDIT_DRAFT = {
  subject: "buy 2 get 1",
  previewText: "exclusive deal",
  headline: "limited time buy 2 get 1",
  body: "hurry act fast",
  promoCode: "b2g1",
  ctaLabel: "SHOP NOW",
};

/** Copy in the register of the automations that are already delivering. */
const CLEAN_CAMPAIGN = {
  subject: "Buy two, get one this week",
  previewText: "Your third unit is included through Sunday.",
  headline: "Buy two, get one",
  body:
    "Order any two units this week and the third is included automatically at checkout.\n\n" +
    "Every batch is third-party tested, and a COA is available for each one on request.",
  promoCode: "B2G1",
  ctaLabel: "Shop the catalog",
};

describe("checkCampaignDeliverability", () => {
  it("rates the campaign the audit found as high risk", () => {
    const report = checkCampaignDeliverability(AUDIT_DRAFT);
    expect(report.risk).toBe("high");
  });

  it("rates equivalent copy without the trigger phrasing as low risk", () => {
    const report = checkCampaignDeliverability(CLEAN_CAMPAIGN);
    expect(report.risk).toBe("low");
    expect(report.findings).toEqual([]);
  });
});

describe("thin bodies", () => {
  // A body of a few words wrapped around a discount code and a link is a
  // message with no content and an offer — which is what an advert stripped of
  // its pretext looks like to a filter, and what it looks like to a reader too.
  const codes = (report: { findings: Array<{ code: string }> }) => report.findings.map((f) => f.code);

  it("flags a body of a handful of words carrying a promo code", () => {
    const report = checkCampaignDeliverability({
      subject: "Something for you",
      headline: "A note",
      body: "Grab it today.",
      promoCode: "SAVE20",
      ctaLabel: "Shop the catalog",
    });
    expect(codes(report)).toContain("thin_body");
    expect(report.risk).toBe("high");
  });

  it("does not flag a body that carries real content", () => {
    const report = checkCampaignDeliverability({
      subject: "Something for you",
      headline: "A note",
      body:
        "Order any two units this week and the third is included automatically at checkout. " +
        "Every batch is third-party tested, and a COA is available for each one on request.",
      promoCode: "SAVE20",
      ctaLabel: "Shop the catalog",
    });
    expect(codes(report)).not.toContain("thin_body");
  });

  it("treats a short body without a promo code as a warning, not a blocker", () => {
    const report = checkCampaignDeliverability({
      subject: "Something for you",
      headline: "A note",
      body: "Your order shipped today.",
      promoCode: null,
      ctaLabel: "Track it",
    });
    expect(codes(report)).toContain("thin_body");
    expect(report.risk).toBe("medium");
  });
});

const LONG_BODY =
  "Order any two units this week and the third is included automatically at checkout. " +
  "Every batch is third-party tested, and a COA is available for each one on request.";

/** A campaign that is clean apart from whatever the test overrides. */
function copyWith(overrides: Partial<Parameters<typeof checkCampaignDeliverability>[0]>) {
  return checkCampaignDeliverability({
    subject: "Buy two, get one this week",
    previewText: "Your third unit is included through Sunday.",
    headline: "Buy two, get one",
    body: LONG_BODY,
    promoCode: "B2G1",
    ctaLabel: "Shop the catalog",
    ...overrides,
  });
}
const codesOf = (report: { findings: Array<{ code: string }> }) => report.findings.map((f) => f.code);

describe("subject lines", () => {
  it("flags a subject shouted in capitals", () => {
    expect(codesOf(copyWith({ subject: "BUY TWO GET ONE THIS WEEK" }))).toContain("shouting_subject");
  });

  it("does not flag an acronym inside an otherwise normal subject", () => {
    // "COA" is this store's own vocabulary and appears in real subject lines.
    expect(codesOf(copyWith({ subject: "Your COA is ready to download" }))).not.toContain("shouting_subject");
  });

  it("flags repeated exclamation marks", () => {
    expect(codesOf(copyWith({ subject: "Buy two, get one!!!" }))).toContain("excessive_punctuation");
  });

  it("accepts a single exclamation mark", () => {
    expect(codesOf(copyWith({ subject: "Buy two, get one!" }))).not.toContain("excessive_punctuation");
  });

  it("flags a subject long enough to be truncated in the inbox", () => {
    expect(
      codesOf(copyWith({ subject: "Buy two units of anything in the catalog this week and we will include the third one at no extra cost" })),
    ).toContain("subject_too_long");
  });

  it("flags an empty subject", () => {
    expect(codesOf(copyWith({ subject: "   " }))).toContain("subject_missing");
  });
});

describe("preview text", () => {
  it("warns when it is missing, because the headline is then shown twice", () => {
    expect(codesOf(copyWith({ previewText: "" }))).toContain("preview_text_missing");
  });

  it("is satisfied by preview text that differs from the headline", () => {
    expect(codesOf(copyWith({ previewText: "Your third unit is included through Sunday." })))
      .not.toContain("preview_text_missing");
  });
});
