import { describe, expect, it } from "vitest";
import {
  cartRecoveryT24hTemplate,
  commissionEarnedTemplate,
  orderConfirmationTemplate,
  passwordResetTemplate,
  shippingUpdateTemplate,
  membershipCancellationTemplate,
  ambassadorPayoutTemplate,
} from "@/lib/email/templates";

describe("commissionEarnedTemplate", () => {
  const template = commissionEarnedTemplate({
    name: "Jordan",
    commissionAmount: 12.5,
    unpaidBalance: 47.25,
    referralCode: "JORDAN10",
    dashboardUrl: "https://vantalabsresearch.com/account/ambassador",
  });
  const body = `${template.subject}\n${template.html}\n${template.text}`;

  it("includes only the four approved fields", () => {
    expect(body).toContain("$12.50"); // commission earned
    expect(body).toContain("$47.25"); // running unpaid balance
    expect(body).toContain("JORDAN10"); // referral code used
    expect(body.toLowerCase()).toContain("every two weeks"); // biweekly reminder
  });

  it("never leaks sensitive business data", () => {
    // No order totals, customer identity, revenue, product mix, or fraud data.
    // (The store's own contact address in the shared footer is not a leak.)
    const lowered = body.toLowerCase();
    for (const forbidden of ["customer", "order total", "revenue", "subtotal", "fraud", "tier"]) {
      expect(lowered).not.toContain(forbidden);
    }
  });
});

describe("membershipCancellationTemplate", () => {
  it("confirms cancellation and shows the access-until date", () => {
    const t = membershipCancellationTemplate({ name: "Sam", tierName: "Priority", accessUntil: "Aug 1, 2026", resubscribeUrl: "https://vantalabsresearch.com/membership" });
    const body = `${t.subject}\n${t.html}\n${t.text}`;
    expect(body.toLowerCase()).toContain("cancel");
    expect(body).toContain("Priority");
    expect(body).toContain("Aug 1, 2026");
  });
});

describe("ambassadorPayoutTemplate", () => {
  it("cash payout mentions the amount", () => {
    const t = ambassadorPayoutTemplate({ name: "Jordan", amount: 120, method: "cash", dashboardUrl: "https://vantalabsresearch.com/account/ambassador" });
    const body = `${t.subject}\n${t.html}\n${t.text}`;
    expect(body).toContain("$120.00");
    expect(body.toLowerCase()).toContain("payout");
  });

  it("store-credit payout shows both the basis and the credited amount", () => {
    const t = ambassadorPayoutTemplate({ name: "Jordan", amount: 100, method: "store_credit", creditAmount: 125, dashboardUrl: "https://vantalabsresearch.com/account/ambassador" });
    const body = `${t.subject}\n${t.html}\n${t.text}`;
    expect(body).toContain("$100.00");
    expect(body).toContain("$125.00");
    expect(body.toLowerCase()).toContain("store credit");
  });
});

describe("customer emails never reference the ambassador program", () => {
  const customerEmails = [
    orderConfirmationTemplate({
      customerName: "Sam",
      orderId: "VL-1001",
      items: [{ name: "Sample", quantity: 1, lineTotal: 50 }],
      subtotal: 50,
      shipping: 5,
      discount: 0,
      total: 55,
    }),
    shippingUpdateTemplate({ customerName: "Sam", orderId: "VL-1001", status: "Shipped" }),
    passwordResetTemplate({ name: "Sam", resetUrl: "https://vantalabsresearch.com/account/reset-password" }),
    cartRecoveryT24hTemplate({
      name: "Sam",
      items: [{ name: "Sample", quantity: 1 }],
      cartValueCents: 5000,
      restoreUrl: "https://vantalabsresearch.com/cart/restore",
      couponCode: "SAVE5",
      expiresAt: "soon",
    }),
  ];

  it("contains no ambassador/commission/referral wording", () => {
    for (const email of customerEmails) {
      const lowered = `${email.subject}\n${email.html}\n${email.text}`.toLowerCase();
      expect(lowered).not.toContain("ambassador");
      expect(lowered).not.toContain("commission");
      expect(lowered).not.toContain("referral");
    }
  });
});
