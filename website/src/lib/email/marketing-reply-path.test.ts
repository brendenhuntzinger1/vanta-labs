import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveMarketingReplyTo, type EmailRuntimeConfig } from "@/lib/email/settings";

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), "src", rel), "utf8");
const MARKETING = read("lib/email/marketing.ts");

// ---------------------------------------------------------------------------
// A MARKETING SEND MUST BE REPLYABLE, AND ITS OPT-OUT MAILTO MUST REACH SOMEONE.
//
// On 2026-09-02 marketing was split onto its own subdomain —
// mail.vantalabsresearch.com — so that campaign complaints could not damage the
// reputation carrying receipts, password resets and affiliate mail. That is the
// right split and it stays.
//
// What it broke: a Resend SENDING domain is send-only. mail.vantalabsresearch.com
// has no MX at all, so `news@mail.vantalabsresearch.com` cannot receive
// anything. The moment the split went live, two things started bouncing:
//
//   * a customer pressing Reply on a campaign;
//   * the `mailto:` in List-Unsubscribe, which reputation-separation.test.ts had
//     deliberately derived from the send From.
//
// That derivation was correct reasoning about REPUTATION alignment and wrong
// about DELIVERY, because it assumed the From was a mailbox. RFC 8058 expects a
// mailto opt-out to be honoured within two days, and an opt-out that bounces is
// the complaint that follows — the exact outcome the split existed to prevent.
//
// So the two are separated on purpose now: the message is FROM the marketing
// subdomain (reputation), and REPLY-TO an address that actually receives
// (delivery). A cross-domain Reply-To is ordinary and costs nothing; a From
// nobody can answer costs a customer.
// ---------------------------------------------------------------------------

function config(overrides: Partial<EmailRuntimeConfig> = {}): EmailRuntimeConfig {
  return {
    enabled: true,
    provider: "resend",
    from: "orders@vantalabsresearch.com",
    smtp: { host: "", port: 587, secure: false, user: "", password: "" },
    resend: { apiKey: "re_test" },
    sendgrid: { apiKey: "" },
    marketingPostalAddress: "30929 Mirada Blvd",
    marketingFrom: "Vanta Labs <news@mail.vantalabsresearch.com>",
    marketingReplyTo: "",
    ...overrides,
  };
}

describe("resolveMarketingReplyTo", () => {
  it("falls back to the transactional From, which is a real mailbox", () => {
    // The send-only marketing subdomain must never be the default answer here.
    expect(resolveMarketingReplyTo(config())).toBe("orders@vantalabsresearch.com");
  });

  it("prefers an explicitly configured reply address", () => {
    expect(resolveMarketingReplyTo(config({ marketingReplyTo: "support@vantalabsresearch.com" })))
      .toBe("support@vantalabsresearch.com");
  });

  it("ignores a whitespace-only setting rather than sending an empty Reply-To", () => {
    expect(resolveMarketingReplyTo(config({ marketingReplyTo: "   " }))).toBe("orders@vantalabsresearch.com");
  });
});

describe("sendMarketingEmail", () => {
  it("still sends FROM the marketing subdomain, so reputation stays split", () => {
    expect(MARKETING).toContain("const marketingFrom = resolveMarketingFrom(emailConfig)");
    expect(MARKETING).toContain("from: marketingFrom,");
  });

  it("sets a Reply-To, so a customer pressing Reply reaches a mailbox", () => {
    expect(MARKETING).toContain("resolveMarketingReplyTo(emailConfig)");
    expect(MARKETING).toContain("replyTo:");
  });

  it("builds the unsubscribe mailto from the REPLY address, not the send-only From", () => {
    expect(MARKETING).toContain("extractEmailAddress(marketingReplyTo)");
    expect(MARKETING).not.toContain("extractEmailAddress(marketingFrom)");
  });
});

describe("the campaign TEST send", () => {
  // It deliberately bypasses sendMarketingEmail so a test is not logged as a
  // campaign send — which also means it does not inherit any of the fixes made
  // there. It carried its own copy of the same mailto bug.
  const ROUTE = read("app/api/admin/email/campaigns/[campaignId]/send/route.ts");

  it("is replyable, exactly like a real campaign", () => {
    expect(ROUTE).toContain("resolveMarketingReplyTo(config)");
    expect(ROUTE).toContain("replyTo:");
  });

  it("does not point its unsubscribe mailto at the send-only marketing From", () => {
    expect(ROUTE).not.toContain("extractEmailAddress(resolveMarketingFrom(config))");
  });
});
