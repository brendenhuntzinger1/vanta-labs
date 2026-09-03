import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractEmailAddress } from "@/lib/email/marketing";

/**
 * THE ARCHITECTURAL INVARIANT THIS FILE DEFENDS.
 *
 * Receipts, shipping notices, password resets and ambassador approvals must
 * never inherit the sending reputation of campaigns and cart recovery, and a
 * marketing unsubscribe must never silence any of them. The separation is
 * structural — two send paths, one wrapper — and structure is exactly what a
 * well-meaning refactor collapses. These are source-level assertions because
 * the property is about which path a template travels, which no rendered
 * output can show.
 */

const R = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SEND = R("src/lib/email/send.ts");
const MARKETING = R("src/lib/email/marketing.ts");
const PARTNER = R("src/lib/partner-portal.ts");

describe("transactional mail never becomes marketing mail", () => {
  it("sendEmail adds no List-Unsubscribe of its own", () => {
    // It forwards headers a caller supplies; it must never manufacture them.
    expect(SEND).not.toContain("List-Unsubscribe");
  });

  it("sendEmail adds no unsubscribe footer and no postal address", () => {
    expect(SEND).not.toMatch(/unsubscrib/i);
    expect(SEND).not.toMatch(/postalAddress|marketingPostalAddress/);
  });

  it("sendEmail consults no suppression list", () => {
    // A marketing unsubscribe or a spam complaint must not stop a receipt, a
    // shipping notice or a password reset. If this ever reads
    // email_suppressions, that guarantee is gone.
    expect(SEND).not.toContain("email_suppressions");
    expect(SEND).not.toContain("customer_preferences");
  });
});

describe("marketing mail carries what the law and the filters require", () => {
  it("gates on the suppression list before sending", () => {
    expect(MARKETING).toContain("email_suppressions");
  });

  it("sets both one-click unsubscribe headers", () => {
    expect(MARKETING).toContain('"List-Unsubscribe"');
    expect(MARKETING).toContain('"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"');
  });

  it("appends the CAN-SPAM postal address", () => {
    expect(MARKETING).toContain("marketingPostalAddress");
  });
});

describe("the From used by marketing and its opt-out header cannot diverge", () => {
  /**
   * The bug this locks out: List-Unsubscribe named `emailConfig.from` (the
   * TRANSACTIONAL address) while the message was sent from
   * resolveMarketingFrom(). Identical while no marketing From is configured —
   * so it would have surfaced only on the day separation was switched on, as an
   * unaligned opt-out header and replies landing in the orders mailbox.
   */
  it("resolves the send From from one place, so the subdomain split cannot be half-applied", () => {
    expect(MARKETING).toContain("const marketingFrom = resolveMarketingFrom(emailConfig)");
    expect(MARKETING).toContain("from: marketingFrom,");
  });

  /**
   * SUPERSEDED, 2026-09-02 — and worth saying why rather than deleting.
   *
   * This used to require the unsubscribe mailto be built from `marketingFrom`,
   * on the reasoning that an opt-out header naming a different domain than the
   * message is the shape filters score against. True as far as it goes, and it
   * assumed the marketing From was a mailbox.
   *
   * It is not. A Resend SENDING domain is send-only; mail.vantalabsresearch.com
   * has no MX, so aligning the mailto to it pointed every opt-out at a black
   * hole. A bouncing opt-out is worse than a cross-domain one by a wide margin —
   * RFC 8058 expects it honoured in two days, and the complaint that follows is
   * exactly what the split was protecting the transactional domain from.
   *
   * So the mailto now follows the REPLY address. The original concern it names —
   * that the mailto must never silently drift back to the transactional From
   * while the message ships from somewhere else — is still enforced below.
   */
  it("builds the unsubscribe mailto from an address that can actually receive", () => {
    expect(MARKETING).toContain("extractEmailAddress(marketingReplyTo)");
  });

  it("no longer builds the unsubscribe mailto from the transactional From", () => {
    expect(MARKETING).not.toContain("mailto:${emailConfig.from}");
  });
});

describe("extractEmailAddress", () => {
  it("unwraps a display-name From", () => {
    expect(extractEmailAddress("Vanta Labs <news@mail.vantalabsresearch.com>")).toBe("news@mail.vantalabsresearch.com");
  });

  it("passes a bare address through", () => {
    expect(extractEmailAddress("news@mail.vantalabsresearch.com")).toBe("news@mail.vantalabsresearch.com");
  });

  it("returns empty for anything that is not an address, so the header is omitted rather than malformed", () => {
    for (const junk of ["", "   ", "Vanta Labs", "<>", "not-an-address"]) {
      expect(extractEmailAddress(junk)).toBe("");
    }
  });
});

describe("the ambassador approval email is transactional", () => {
  it("is sent through the transactional path, never the marketing wrapper", () => {
    expect(PARTNER).not.toContain("sendMarketingEmail");
  });

  it("carries a Reply-To, because its copy tells the recipient to reply", () => {
    expect(PARTNER).toContain("replyTo = business?.supportEmail || undefined");
    expect(PARTNER).toContain("`ambassador ${input.status}`, { replyTo }");
  });
});
