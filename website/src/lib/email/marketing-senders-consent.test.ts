import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// EVERY PROMOTIONAL SENDER GOES THROUGH THE ONE WRAPPER — pinned, not assumed.
//
// sendMarketingEmail is where suppression (unsubscribe, bounce, complaint),
// the one-click unsubscribe headers, the CAN-SPAM address and the marketing
// frequency guard live. A promotional message that reached sendEmail directly
// would skip all four. The audit found the membership welcome / win-back /
// birthday mails went through the wrapper only by convention; this makes it a
// test. Transactional mail (receipts, shipping, auth) must NOT go through it,
// and that is pinned by reputation-separation.test.ts.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const PROMOTIONAL_SENDERS: Array<{ file: string; campaignTypes: string[]; queuesOnDeferral: boolean }> = [
  { file: "email/automations.ts", campaignTypes: ["automation:"], queuesOnDeferral: false },
  { file: "email/campaign-sender.ts", campaignTypes: ["campaign", "affiliate_campaign"], queuesOnDeferral: false },
  { file: "cart-recovery.ts", campaignTypes: ["cart_recovery_"], queuesOnDeferral: false },
  { file: "back-in-stock.ts", campaignTypes: ["back_in_stock"], queuesOnDeferral: true },
  { file: "marketing-broadcast.ts", campaignTypes: ["coupon_announcement"], queuesOnDeferral: true },
  { file: "membership-billing.ts", campaignTypes: ["membership_welcome", "membership_winback"], queuesOnDeferral: true },
  { file: "membership.ts", campaignTypes: ["membership_birthday"], queuesOnDeferral: true },
];

describe("promotional senders use the marketing wrapper", () => {
  for (const sender of PROMOTIONAL_SENDERS) {
    it(`${sender.file} sends ${sender.campaignTypes.join(", ")} through sendMarketingEmail`, () => {
      const code = read(sender.file);
      expect(code, `${sender.file} must import sendMarketingEmail`).toMatch(/import \{[^}]*sendMarketingEmail[^}]*\} from "@\/lib\/email\/marketing"/);
      // The sweep-style senders pass their campaign type through a variable;
      // what matters is that the type is minted in this file and every send in
      // it goes through the wrapper (no sendEmail( call outside the import).
      for (const type of sender.campaignTypes) {
        expect(code, `${sender.file} must name the campaign type ${type}`).toContain(type);
      }
      expect(code, `${sender.file} must not call the transactional sendEmail for promotional mail`).not.toMatch(/\bsendEmail\(\{\s*to:[^}]*campaignType/);
    });

    if (sender.queuesOnDeferral) {
      it(`${sender.file} parks a deferred send in the queue rather than losing it`, () => {
        const code = read(sender.file);
        const occurrences = code.split('onDeferred: "queue"').length - 1;
        expect(occurrences, `${sender.file} should queue on deferral for each promotional send`).toBeGreaterThanOrEqual(sender.campaignTypes.length);
      });
    }
  }

  it("the wrapper itself checks suppression and the sink list before the guard, on every path", () => {
    const code = read("email/marketing.ts");
    // Both entry points refuse a suppressed or sink address before any claim is
    // taken — the rendered path and the queue's drain path.
    expect(code.split("isNonMailableAddress(email)").length - 1).toBeGreaterThanOrEqual(2);
    expect(code.split('from("email_suppressions")').length - 1).toBeGreaterThanOrEqual(2);
    expect(code.indexOf('from("email_suppressions")')).toBeLessThan(code.indexOf("claimMarketingSend({"));
  });
});
