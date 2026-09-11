import { describe, expect, it } from "vitest";
import { cartRecoveryPaymentFailedTemplate } from "@/lib/email/templates";
import { findCopyComplianceIssue } from "@/lib/email/copy-compliance";

const base = {
  name: "Sam",
  items: [{ name: "BPC-157 5mg", quantity: 2, unitPriceCents: 5999 }],
  cartValueCents: 11998,
  restoreUrl: "https://www.vantalabsresearch.com/api/email/track/click?id=x&url=y",
  orderNumber: "VL-ABC123",
};

describe("the payment-failed first stage", () => {
  it("names the order, says what the record proves and nothing more, and asks for one thing", () => {
    const declined = cartRecoveryPaymentFailedTemplate({ ...base, failure: "declined" });
    expect(declined.subject).toBe("Your payment did not go through");
    expect(declined.text).toContain("VL-ABC123");
    expect(declined.text).toContain("declined");
    expect(declined.text).toContain("nothing was charged");
    expect(declined.html).toContain("Complete my order");
    expect(declined.text).toMatch(/reply to this message/i);
    expect(declined.text).toContain("Items total: $119.98");
  });

  it("describes an expired checkout as not completed, and still says nothing was charged", () => {
    const expired = cartRecoveryPaymentFailedTemplate({ ...base, failure: "expired" });
    expect(expired.subject).toBe("Your order was not completed");
    expect(expired.text).toContain("nothing was charged");
    expect(expired.text).not.toContain("declined");
  });

  it("makes no claim about the bank when the failure kind is unknown", () => {
    const other = cartRecoveryPaymentFailedTemplate({ ...base, failure: "other" });
    expect(other.subject).toBe("Your order was not completed");
    expect(other.text).not.toContain("declined");
    expect(other.text).not.toContain("nothing was charged");
    expect(other.text).toContain("did not complete");
  });

  it("carries no offer, no code, no urgency and passes the copy rules", () => {
    for (const failure of ["declined", "expired", "other"] as const) {
      const mail = cartRecoveryPaymentFailedTemplate({ ...base, failure });
      expect(mail.html).not.toMatch(/free gift|% off|SAVE-|hurry|last chance|expires/i);
      expect(findCopyComplianceIssue(mail.subject)).toBeNull();
      expect(findCopyComplianceIssue(mail.text)).toBeNull();
    }
  });

  it("escapes an order number that carries markup", () => {
    const mail = cartRecoveryPaymentFailedTemplate({ ...base, failure: "declined", orderNumber: "VL-<script>" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("VL-&lt;script&gt;");
  });
});
