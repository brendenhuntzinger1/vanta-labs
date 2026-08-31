import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { orderCancelledTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { FULFILLMENT_STATUS_LABELS } from "@/lib/order-pipeline";

const R = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the cancellation email does not promise a refund nobody issued", () => {
  /**
   * `refundNote` is passed by nothing — the sole caller supplies customerName,
   * orderId, reason and supportEmail — so the fallback ALWAYS renders. It used
   * to say the payment "is being returned to your original payment method…
   * within 5-10 business days" while the cancel block issues no refund at all.
   */
  const cancelled = () => orderCancelledTemplate({
    customerName: "Zain", orderId: "VL-1001", reason: "Out of stock",
    supportEmail: "support@vantalabsresearch.com",
  });

  it("states no refund timeline it cannot keep", () => {
    const { html, text } = cancelled();
    for (const body of [html, text ?? ""]) {
      expect(body).not.toMatch(/5\s*[-–]\s*10 business days/);
      expect(body).not.toMatch(/is being returned/i);
    }
  });

  it("still tells the customer they will not be billed further", () => {
    const { html } = cancelled();
    expect(html).toMatch(/will not be billed anything further/i);
  });

  it("routes an already-charged customer to a human rather than to a promise", () => {
    const { html, text } = cancelled();
    expect(html).toMatch(/if you were already charged/i);
    expect(text ?? "").toMatch(/if you were already charged/i);
  });

  it("an explicit refundNote still wins, so a real refund can be described precisely", () => {
    const { html } = orderCancelledTemplate({
      customerName: "Zain", orderId: "VL-1001",
      refundNote: "We refunded $124.98 to your Visa ending 4242.",
      supportEmail: "support@vantalabsresearch.com",
    });
    expect(html).toContain("We refunded $124.98 to your Visa ending 4242.");
    expect(html).not.toMatch(/will not be billed anything further/i);
  });
});

describe("shipping updates never show the customer an internal enum", () => {
  it("renders whatever status string the caller passes — so callers must map first", () => {
    const { html } = shippingUpdateTemplate({
      customerName: "Zain", orderId: "VL-1001", status: FULFILLMENT_STATUS_LABELS.shipped,
      trackingUrl: "https://www.vantalabsresearch.com/account/orders",
    });
    expect(html).toContain(FULFILLMENT_STATUS_LABELS.shipped);
    expect(html).not.toContain("label_purchased");
  });

  it("both admin send sites map through FULFILLMENT_STATUS_LABELS", () => {
    // The Shippo path always did; these two did not, so a customer could read
    // "Order VL-1001 is now: label_purchased".
    const single = R("src/app/api/admin/orders/[orderId]/route.ts");
    const bulk = R("src/lib/admin-orders.ts");
    expect(single).toContain("FULFILLMENT_STATUS_LABELS[raw as keyof typeof FULFILLMENT_STATUS_LABELS]");
    expect(bulk).toContain("FULFILLMENT_STATUS_LABELS[nextStatus as keyof typeof FULFILLMENT_STATUS_LABELS]");
    expect(single).not.toContain('status: String(transitionedTo ?? order.fulfillment_status ?? "updated"),');
    expect(bulk).not.toMatch(/^\s*status: nextStatus,$/m);
  });

  it("every fulfillment status has a human label to map to", () => {
    for (const [key, label] of Object.entries(FULFILLMENT_STATUS_LABELS)) {
      expect(label).toBeTruthy();
      expect(label).not.toBe(key);
    }
  });
});

describe("the campaign test send cannot become a back door", () => {
  const ROUTE = R("src/app/api/admin/email/campaigns/[campaignId]/send/route.ts");

  it("refuses a suppressed address", () => {
    // This path skips sendMarketingEmail on purpose (no logging, no metrics),
    // and that used to mean it skipped the suppression list too — so a full
    // campaign could reach someone who had unsubscribed or reported spam.
    expect(ROUTE).toContain("await isMarketingSuppressed(testEmail)");
  });

  it("attaches one-click unsubscribe headers even though it bypasses the wrapper", () => {
    expect(ROUTE).toContain('"List-Unsubscribe"');
    expect(ROUTE).toContain('"List-Unsubscribe-Post": "List-Unsubscribe=One-Click"');
  });

  it("sends from the marketing identity, not the transactional one", () => {
    expect(ROUTE).toContain("resolveMarketingFrom(config)");
  });
});

describe("the trial confirmation is a billing disclosure, not marketing", () => {
  it("the guidance comment no longer calls all four unwired templates promotional", () => {
    const T = R("src/lib/email/templates.ts");
    expect(T).not.toContain("(they are all promotional)");
    expect(T).toContain("THEY ARE NOT ALL PROMOTIONAL");
  });

  it("its billing siblings are on the transactional path", () => {
    // If these ever move, a member could unsubscribe from marketing and then be
    // charged with no notice.
    const BILLING = R("src/lib/membership-billing.ts");
    for (const name of ["membershipRemainderReminderTemplate", "membershipRenewalReminderTemplate", "membershipSignupReceiptTemplate"]) {
      expect(BILLING).toContain(name);
    }
  });
});

describe("the cancellation footer does not print support twice", () => {
  /** Found by browser render, not by a unit test — renderLayout already emits
   *  "Questions? support@vantalabsresearch.com", and this template added a
   *  second, near-identical line directly beneath it. */
  it("prints the default support address once, not twice", () => {
    const { html } = orderCancelledTemplate({
      customerName: "Zain", orderId: "VL-1001",
      supportEmail: "support@vantalabsresearch.com",
    });
    expect(html.match(/support@vantalabsresearch\.com/g)?.length).toBe(2); // one mailto href + one label
    expect(html).not.toContain("Reach us at");
  });

  it("still surfaces a CONFIGURED address that differs from the layout's", () => {
    const { html } = orderCancelledTemplate({
      customerName: "Zain", orderId: "VL-1001", supportEmail: "help@vantalabsresearch.com",
    });
    expect(html).toContain("help@vantalabsresearch.com");
    expect(html).toContain("Reach us at");
  });
});
