import { describe, expect, it } from "vitest";

import * as templates from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// ONE BAR, APPLIED TO EVERY EMAIL THIS APP CAN SEND.
//
// On 2026-08-29 a signup confirmation was DELIVERED — Resend said so — and
// still failed, because Gmail classified it as spam and spam messages have
// their links stripped. The recipient opened an email with nothing to click
// and reported, accurately, that "the email doesn't have a link".
//
// The message that did that was a bare <h2>, one sentence and a naked <a>. The
// order confirmations, on the same domain through the same Resend account,
// landed every time — because they are branded, carry a real button, and ship
// a plain-text alternative. The difference was never deliverability. It was the
// message.
//
// So this file walks EVERY exported template, renders it with representative
// input, and holds it to the bar the working emails already met. A new template
// that skips renderLayout, forgets its text part, or interpolates an undefined
// into the body fails here rather than in somebody's spam folder.
//
// Adding a template means adding it to INPUTS below. That is deliberate: the
// list not compiling is how you find out you have written an email nobody
// checked.
// ---------------------------------------------------------------------------

const URL_ = "https://www.vantalabsresearch.com/account";
const ITEMS = [{ name: "BPC-157 5mg", quantity: 2, lineTotal: 119.98 }];

/** Representative input for every exported template, keyed by name. */
const INPUTS: Record<string, unknown> = {
  couponAnnouncementTemplate: { headline: "10% off", code: "SAVE10", discountLabel: "10% off", message: "Enjoy.", endsAt: "2026-09-30T00:00:00Z", shopUrl: URL_ },
  accountConfirmationTemplate: { name: "Zain", confirmUrl: URL_ },
  accountConfirmationResendTemplate: { name: "Zain", confirmUrl: URL_ },
  passwordResetTemplate: { name: "Zain", resetUrl: URL_ },
  orderConfirmationTemplate: { customerName: "Zain", orderId: "VL-1001", items: ITEMS, subtotal: 119.98, shipping: 5, total: 124.98, orderUrl: URL_, shippingAddress: "1 Nowhere Lane" },
  reimbursementRecordedTemplate: { customerName: "Zain", orderId: "VL-1001", amount: 25, supportEmail: "support@vantalabsresearch.com" },
  refundConfirmationTemplate: { customerName: "Zain", orderId: "VL-1001", refundAmount: 25, isFullRefund: false, supportEmail: "support@vantalabsresearch.com" },
  manualPaymentReceivedTemplate: { customerName: "Zain", orderNumber: "VL-1001", amount: 124.98, paymentMethod: "Zelle" },
  newPaymentToVerifyTemplate: { orderNumber: "VL-1001", customerName: "Zain", customerEmail: "z@example.test", amount: 124.98, paymentMethod: "Zelle", transactionId: "T-1", adminUrl: URL_ },
  manualPaymentRejectedTemplate: { customerName: "Zain", orderNumber: "VL-1001", reason: "Amount mismatch", resubmitUrl: URL_ },
  shippingUpdateTemplate: { customerName: "Zain", orderId: "VL-1001", status: "shipped", carrier: "USPS", trackingNumber: "9400111", trackingUrl: URL_ },
  replacementOrderTemplate: { customerName: "Zain", originalOrderNumber: "VL-1001", replacementOrderNumber: "VL-1002", items: [{ name: "BPC-157 5mg", quantity: 1 }], supportEmail: "support@vantalabsresearch.com" },
  deliveryConfirmationTemplate: { customerName: "Zain", orderId: "VL-1001" },
  ambassadorInviteTemplate: { name: "Zain", inviteUrl: URL_, commissionPercent: 20 },
  ambassadorApplicationReceivedTemplate: { name: "Zain" },
  ambassadorApprovedTemplate: { name: "Zain", referralCode: "ZAIN", dashboardUrl: URL_, commissionPercent: 20, personalDiscountPercent: 20, referralDiscountPercent: 10 },
  ambassadorPayoutSentTemplate: { name: "Zain", amount: 250, method: "PayPal", handle: "z@example.test", orderCount: 5, dashboardUrl: URL_ },
  ambassadorInfoRequestedTemplate: { name: "Zain", supportEmail: "support@vantalabsresearch.com", applicationUrl: URL_ },
  ambassadorDeniedTemplate: { name: "Zain" },
  commissionEarnedTemplate: { name: "Zain", commissionAmount: 24, unpaidBalance: 120, referralCode: "ZAIN", dashboardUrl: URL_ },
  newAmbassadorApplicationTemplate: { applicantName: "Zain", applicantEmail: "z@example.test", adminUrl: URL_ },
  referralCodeAssignedTemplate: { name: "Zain", referralCode: "ZAIN", referralLink: URL_, commissionPercent: 20, dashboardUrl: URL_ },
  membershipWelcomeTemplate: { name: "Zain", tierName: "Vault" },
  membershipTrialConfirmationTemplate: { name: "Zain", tierName: "Vault", introChargeCents: 100, remainderCents: 900, remainderChargeDate: "2026-09-30", monthlyPriceCents: 1000 },
  membershipRemainderReminderTemplate: { name: "Zain", remainderCents: 900, chargeDate: "2026-09-30" },
  membershipRemainderReceiptTemplate: { name: "Zain", remainderCents: 900, nextBillingDate: "2026-10-30", monthlyPriceCents: 1000 },
  membershipRenewalReminderTemplate: { name: "Zain", monthlyPriceCents: 1000, chargeDate: "2026-09-30" },
  membershipRenewalReceiptTemplate: { name: "Zain", monthlyPriceCents: 1000, nextBillingDate: "2026-10-30" },
  membershipSignupReceiptTemplate: { name: "Zain", tierName: "Vault", amountCents: 1000, billingCycle: "monthly", nextBillingDate: "2026-10-30", autoRenews: true },
  membershipPaymentFailedTemplate: { name: "Zain", amountCents: 1000, updatePaymentUrl: URL_ },
  membershipBenefitsMonthlyTemplate: { name: "Zain", headline: "Your perks", bodyHtml: "<p>Enjoy.</p>", ctaLabel: "Shop", ctaUrl: URL_ },
  membershipBirthdayTemplate: { name: "Zain", bonusPoints: 500 },
  membershipWinBackTemplate: { name: "Zain", tierName: "Vault", offerPercent: 20, resubscribeUrl: URL_ },
  newProductLaunchTemplate: { name: "Zain", productName: "BPC-157", productUrl: URL_ },
  backInStockTemplate: { name: "Zain", productName: "BPC-157", productUrl: URL_ },
  cartRecoveryT30mTemplate: { name: "Zain", items: [{ name: "BPC-157", quantity: 1 }], cartValueCents: 11998, restoreUrl: URL_ },
  cartRecoveryT12hTemplate: { name: "Zain", items: [{ name: "BPC-157", quantity: 1 }], cartValueCents: 11998, restoreUrl: URL_ },
  cartRecoveryT24hTemplate: { name: "Zain", items: [{ name: "BPC-157", quantity: 1 }], cartValueCents: 11998, restoreUrl: URL_, couponCode: "COMEBACK", expiresAt: "2026-09-30T00:00:00Z" },
  cartRecoveryT72hTemplate: { name: "Zain", items: [{ name: "BPC-157", quantity: 1 }], cartValueCents: 11998, restoreUrl: URL_, couponCode: "COMEBACK", expiresAt: "2026-09-30T00:00:00Z" },
  contactFormNotificationTemplate: { firstName: "Zain", lastName: "M", email: "z@example.test", orderNumber: "VL-1001", subject: "Question", message: "Hello" },
  contactFormAutoReplyTemplate: { firstName: "Zain", subject: "Question", message: "Hello" },
  wholesaleInquiryNotificationTemplate: { firstName: "Zain", lastName: "M", email: "z@example.test", phone: "+1", organization: "Lab", volume: "100", products: "BPC", message: "Hello" },
  wholesaleInquiryAutoReplyTemplate: { firstName: "Zain" },
  campaignTemplate: { subject: "News", previewText: "News", headline: "News", body: "<p>Hi</p>", promoCode: "SAVE10", ctaLabel: "Shop", ctaUrl: URL_ },
};

type Rendered = { subject: string; html: string; text?: string };

const ALL: Array<readonly [string, (input: unknown) => Rendered]> = Object.entries(
  templates as unknown as Record<string, unknown>,
)
  .filter(([name, fn]) => name.endsWith("Template") && typeof fn === "function")
  .map(([name, fn]) => [name, fn as (input: unknown) => Rendered] as const);

/** Absolute http(s) URLs appearing in a rendered body. */
function urlsIn(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  // mailto: and the support address are not CTAs; tracking pixels are not links.
  return [...new Set(found.map((u) => u.replace(/&amp;/g, "&")))];
}

describe("every email template", () => {
  it("has one covering the whole exported surface", () => {
    // A template with no entry in INPUTS is one nobody has checked. Failing
    // here is the point: it is how a new email gets noticed before it ships.
    const uncovered = ALL.map(([name]) => name).filter((name) => !(name in INPUTS));
    expect(uncovered, `templates missing from INPUTS: ${uncovered.join(", ")}`).toEqual([]);
    expect(ALL.length).toBeGreaterThan(40);
  });

  for (const [name, render] of ALL) {
    describe(name, () => {
      const out = render(INPUTS[name]);

      it("has a subject", () => {
        expect(out.subject.trim().length).toBeGreaterThan(0);
      });

      it("ships a plain-text alternative", () => {
        // An HTML-only message is a documented spam signal, and it is the last
        // thing a recipient has when a filter strips the markup.
        expect(out.text, `${name} has no text part`).toBeTruthy();
        expect(String(out.text).trim().length).toBeGreaterThan(0);
      });

      it("is branded, so it does not read as phishing", () => {
        expect(out.html).toContain("Vanta Labs");
        // renderLayout's dark shell. The message that got filtered had none of
        // it; every message that landed had all of it.
        expect(out.html, `${name} does not go through renderLayout`).toContain("background:#050505");
      });

      it("renders no undefined, NaN or [object Object]", () => {
        for (const body of [out.html, String(out.text ?? "")]) {
          expect(body).not.toContain("undefined");
          expect(body).not.toContain("NaN");
          expect(body).not.toContain("[object Object]");
        }
      });

      it("repeats every link in the plain-text part", () => {
        // Gmail strips anchors from anything it files as spam. The text part is
        // the copy that survives that, and it is the only reason a filtered
        // message is still actionable.
        const htmlUrls = urlsIn(out.html).filter((u) => !u.startsWith("mailto:"));
        const textBody = String(out.text ?? "");
        for (const url of htmlUrls) {
          expect(textBody, `${name}: ${url} is in the HTML but not the text part`).toContain(url);
        }
      });

      it("renders any CTA as a real button rather than a naked anchor", () => {
        // The single difference a recipient sees between the confirmation that
        // got ignored and the order email that got clicked.
        const hasCta = out.html.includes("<a href");
        if (!hasCta) return;
        const anchors = out.html.match(/<a href="[^"]*"[^>]*>/g) ?? [];
        const styled = anchors.filter((a) => a.includes("border-radius:999px"));
        const mailtoOnly = anchors.every((a) => a.includes("mailto:"));
        expect(
          styled.length > 0 || mailtoOnly,
          `${name} has anchors but none is a styled CTA: ${anchors.slice(0, 2).join(" ")}`,
        ).toBe(true);
      });
    });
  }
});
