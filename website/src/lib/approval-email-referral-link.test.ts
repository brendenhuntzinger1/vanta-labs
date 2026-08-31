import { describe, expect, it } from "vitest";
import { ambassadorApprovedTemplate } from "@/lib/email/templates";

/**
 * ANDREW / DREW, 2026-08-31.
 *
 * Approved with the referral code already stored on his `ambassadors` row, so
 * `referralCodeChanged` was false and `referralCodeAssignedTemplate` — the only
 * message that carried the /r/CODE share link — never fired.
 * `notification_queue` holds exactly two rows for that address: application
 * received, application approved. The approval email named the code and gave
 * him no link, so he had a live code, a working redirect, and no way to learn
 * the URL existed.
 *
 * The approval email is the one message every approved ambassador is
 * guaranteed to receive. It must be self-sufficient.
 */

const SITE = "https://www.vantalabsresearch.com";
const DASHBOARD = `${SITE}/account/ambassador`;

function approved(overrides: Partial<Parameters<typeof ambassadorApprovedTemplate>[0]> = {}) {
  return ambassadorApprovedTemplate({
    name: "Andrew Hughes",
    referralCode: "DREW",
    siteUrl: SITE,
    dashboardUrl: DASHBOARD,
    commissionPercent: 15,
    personalDiscountPercent: 20,
    referralDiscountPercent: 10,
    holdDays: 30,
    ...overrides,
  });
}

describe("the approval email carries the shareable referral link", () => {
  it("puts the /r/CODE link in the HTML, as a real anchor", () => {
    const { html } = approved();
    expect(html).toContain(`${SITE}/r/DREW`);
    expect(html).toContain(`href="${SITE}/r/DREW"`);
  });

  it("puts it in the plain-text part too", () => {
    const { text } = approved();
    expect(text).toContain(`${SITE}/r/DREW`);
  });

  it("still names the bare code, for anyone typing it at checkout", () => {
    const { html, text } = approved();
    expect(html).toContain("DREW");
    expect(text).toContain("Your referral code: DREW");
  });

  it("does not mistake the dashboard URL for the share link", () => {
    // /account/ambassador is the ambassador's own portal. Sending it as the
    // link to share would 302 their audience to a sign-in page, and tapping it
    // themselves does nothing for attribution.
    const { html } = approved();
    const shareSection = html.slice(html.indexOf("referral link"));
    expect(shareSection).toContain("/r/DREW");
    expect(shareSection.slice(0, shareSection.indexOf("/r/DREW"))).not.toContain("/account/ambassador");
  });
});

describe("deriving the link", () => {
  it("falls back to the dashboard's own origin when no siteUrl is passed", () => {
    const { html } = approved({ siteUrl: undefined });
    expect(html).toContain(`${SITE}/r/DREW`);
  });

  it("prefers an explicit siteUrl over the dashboard origin", () => {
    const { html } = approved({ siteUrl: "https://vantalabsresearch.com" });
    expect(html).toContain("https://vantalabsresearch.com/r/DREW");
  });

  it("percent-encodes a code that would otherwise break the path", () => {
    const { html } = approved({ referralCode: "a b/c" });
    expect(html).toContain("/r/a%20b%2Fc");
  });
});

describe("negative controls", () => {
  it("emits no link section at all when the ambassador has no code yet", () => {
    const { html, text } = approved({ referralCode: undefined });
    expect(html).not.toContain("/r/");
    expect(html).not.toContain("referral link");
    expect(text).not.toContain("/r/");
  });

  it("never emits a relative href, which is dead text in an email client", () => {
    // An unusable origin must drop the link, not ship "/r/DREW" as an href.
    const { html } = approved({ siteUrl: "not a url", dashboardUrl: "also not a url" });
    expect(html).not.toContain('href="/r/');
  });

  it("does not double-append when siteUrl carries a trailing slash", () => {
    const { html } = approved({ siteUrl: `${SITE}/` });
    expect(html).toContain(`${SITE}/r/DREW`);
    expect(html).not.toContain("//r/DREW");
  });
});

/**
 * THE TRIM, AND WHAT IT MUST NOT COST.
 *
 * The approval email was 371 words and 21 promotional terms — "Cash bonuses",
 * "Free products", "no fixed ceiling on what top performers can earn" — shipped
 * as transactional mail with no List-Unsubscribe, no postal address and no
 * Reply-To. That combination is the shape bulk filters score against, on the
 * one message an ambassador cannot afford to miss.
 *
 * Trimming it is only safe if every operative fact survives. These assert the
 * facts, and that the hype did not come back.
 */
describe("the approval email stays transactional in shape", () => {
  const PROMO = /\b(cash bonus(es)?|free products?|giveaways?|no fixed ceiling|unlimited earning)\b/i;

  it("carries no promotional hype", () => {
    const { html, text } = approved();
    expect(html).not.toMatch(PROMO);
    expect(text ?? "").not.toMatch(PROMO);
  });

  it("is short enough to read as a notice rather than a campaign", () => {
    const { html } = approved();
    const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(" ").length;
    // 371 before the trim, 219 after — and that 219 counts the shared layout
    // chrome (header, footer, legal line), not just this template's body. The
    // bar is set above the current value on purpose: this guards against the
    // promotional blocks coming back, not against an honest extra sentence.
    expect(words).toBeLessThan(250);
  });

  it("offers no unsubscribe — a transactional message must not invite opt-out", () => {
    const { html, text } = approved();
    expect(html).not.toMatch(/unsubscrib/i);
    expect(text ?? "").not.toMatch(/unsubscrib/i);
  });
});

describe("every operative fact survives the trim", () => {
  it("states the commission rate, both discounts, and the hold period", () => {
    const { html } = approved();
    expect(html).toContain("15%");   // commission
    expect(html).toContain("10%");   // customers' discount
    expect(html).toContain("20%");   // personal discount
    expect(html).toContain("30 days"); // commission hold
  });

  it("states the code, the link, and the dashboard", () => {
    const { html } = approved();
    expect(html).toContain("DREW");
    expect(html).toContain(`${SITE}/r/DREW`);
    expect(html).toContain(`${SITE}/account/ambassador`);
  });

  it("says the ambassador was approved", () => {
    const { html, subject } = approved();
    expect(html).toMatch(/approved/i);
    expect(subject).toMatch(/approved/i);
  });

  it("names the payout methods and cadence", () => {
    const { html } = approved();
    expect(html).toMatch(/PayPal/);
    expect(html).toMatch(/two weeks/i);
  });

  it("gives a route to a human", () => {
    const { html } = approved();
    expect(html).toMatch(/reply to this email/i);
  });

  it("repeats every HTML link in the plain-text part", () => {
    const { html, text } = approved();
    const hrefs = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(text ?? "").toContain(href);
  });

  it("keeps the same facts in the text part", () => {
    const { text } = approved();
    for (const fact of ["15%", "10%", "20%", "30 days", "DREW", `${SITE}/r/DREW`]) {
      expect(text ?? "").toContain(fact);
    }
  });
});
