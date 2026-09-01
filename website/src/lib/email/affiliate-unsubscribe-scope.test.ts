import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// AN AFFILIATE WHO STOPS THE BROADCASTS MUST STILL GET THEIR MONEY EMAILS.
//
// The owner's requirement, stated plainly: unsubscribing from promotional
// affiliate mail must NOT unsubscribe someone from account, approval,
// commission or payout email.
//
// That property holds by CONSTRUCTION rather than by a rule anyone remembers to
// apply — `sendMarketingEmail` consults email_suppressions and `sendEmail` does
// not — and this file exists to stop that construction being quietly undone.
// The failure it guards against is somebody "tidying up" by moving the
// suppression check down into sendEmail, which would look like consolidation
// and would silently stop paying-out emails reaching people who had merely
// opted out of announcements.
//
// Asserted against the source text on purpose: the property is about WHICH
// MODULE owns the check, and that is not observable from either function's
// return value.
// ---------------------------------------------------------------------------

const LIB = join(process.cwd(), "src/lib/email");
const send = readFileSync(join(LIB, "send.ts"), "utf8");
const marketing = readFileSync(join(LIB, "marketing.ts"), "utf8");

describe("the suppression check lives in the marketing wrapper, and only there", () => {
  it("sendMarketingEmail refuses a suppressed address", () => {
    expect(marketing).toContain("email_suppressions");
    expect(marketing).toContain("suppressed: true");
  });

  it("sendEmail — the transactional path — never consults the suppression list", () => {
    // If this fails, an affiliate who unsubscribed from announcements has just
    // stopped receiving their commission and payout email.
    expect(send).not.toContain("email_suppressions");
  });

  it("sendEmail attaches no List-Unsubscribe header, because a receipt may not opt out", () => {
    expect(send).not.toContain("List-Unsubscribe");
    expect(marketing).toContain("List-Unsubscribe");
  });
});

describe("affiliate transactional mail goes through the transactional path", () => {
  // partner-portal.ts owns approval, referral-code and payout notifications.
  const partnerPortal = readFileSync(join(process.cwd(), "src/lib/partner-portal.ts"), "utf8");

  it("partner-portal sends with sendEmail, not sendMarketingEmail", () => {
    expect(partnerPortal).toContain("sendEmail");
    expect(partnerPortal).not.toContain("sendMarketingEmail");
  });
});

describe("affiliate broadcasts DO go through the marketing wrapper", () => {
  const sender = readFileSync(join(LIB, "campaign-sender.ts"), "utf8");

  it("the campaign sender uses sendMarketingEmail for both audience kinds", () => {
    // One call site, shared by customer and affiliate campaigns — so an
    // affiliate broadcast cannot acquire a path around suppression, the
    // unsubscribe footer, or the postal address.
    expect(sender.match(/sendMarketingEmail\(/g) ?? []).toHaveLength(1);
    expect(sender).not.toContain("sendEmail(");
  });

  it("distinguishes the two kinds in the send log without duplicating the wrapper", () => {
    expect(sender).toContain('"affiliate_campaign"');
    expect(sender).toContain('"campaign"');
  });
});
