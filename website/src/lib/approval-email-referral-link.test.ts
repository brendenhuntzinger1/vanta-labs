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
