import { describe, expect, it } from "vitest";
import {
  cartRecoveryT24hTemplate,
  commissionEarnedTemplate,
  orderConfirmationTemplate,
  passwordResetTemplate,
  shippingUpdateTemplate,
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
    const lowered = body.toLowerCase();
    for (const forbidden of ["customer", "order total", "revenue", "subtotal", "@", "fraud", "tier"]) {
      expect(lowered).not.toContain(forbidden);
    }
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
