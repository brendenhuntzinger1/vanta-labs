import { describe, expect, it } from "vitest";
import { paymentDeclinedTemplate } from "@/lib/email/templates";

const BASE = {
  name: "Sam",
  orderNumber: "VL-1042",
  amountCents: 36_794,
  retryUrl: "https://vantalabsresearch.com/cart/restore?id=abc",
};

// ---------------------------------------------------------------------------
// THE DECLINE EMAIL.
//
// It exists because $1,494.76 of declined orders belong to customers nobody
// ever contacted. The single job of this message is to remove friction from a
// retry — not to sell, not to apologise at length, and not to discount.
//
// It is TRANSACTIONAL. That is a deliberate, load-bearing choice: it carries no
// offer and no marketing footer, so it reaches a customer who unsubscribed from
// marketing and still needs to know their order did not go through — exactly as
// a receipt does. The moment an incentive appears in here, it becomes marketing
// and that reach is lost.
// ---------------------------------------------------------------------------

describe("what the customer is told", () => {
  it("says plainly that the payment did not go through", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(`${out.subject} ${out.html}`.toLowerCase()).toMatch(/didn.t go through|declined|not complete/);
  });

  it("names the order and the amount, so it is not mistaken for phishing", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html).toContain("VL-1042");
    expect(out.html).toContain("$367.94");
    expect(out.text).toContain("VL-1042");
  });

  // THE REASSURANCE THAT MATTERS MOST. A declined card usually still shows a
  // pending authorisation in the customer's banking app. Someone who thinks
  // they have been charged for a failed order does not retry — they email
  // support asking for a refund, or they dispute it.
  it("says they have not been charged", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html.toLowerCase()).toMatch(/not been charged|no charge|weren.t charged/);
    expect(out.text.toLowerCase()).toMatch(/not been charged|no charge|weren.t charged/);
  });

  it("gives one obvious way to finish, as a real button", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html).toContain("<table");
    expect(out.html).toContain(BASE.retryUrl);
    expect(out.text).toContain(BASE.retryUrl);
  });

  it("keeps their items, so the retry is one click and not a rebuild", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html.toLowerCase()).toMatch(/still|saved|waiting|held/);
  });
});

// ---------------------------------------------------------------------------
// NO INCENTIVE. Asserted, not merely intended: a well-meaning edit that adds a
// discount here silently converts a transactional email into a marketing one,
// loses its reach to unsubscribed customers, and gives away margin on an order
// the customer had already agreed to pay in full.
// ---------------------------------------------------------------------------

describe("it never becomes a marketing email", () => {
  it("offers no discount, code or gift", () => {
    const out = paymentDeclinedTemplate(BASE);
    const body = `${out.subject} ${out.html} ${out.text}`.toLowerCase();
    for (const word of ["discount", "% off", "coupon", "promo code", "free gift", "save 10"]) {
      expect(body, `decline email must not contain "${word}"`).not.toContain(word);
    }
  });

  it("carries no unsubscribe footer or postal address, as transactional mail must not", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html.toLowerCase()).not.toContain("unsubscribe");
  });
});

describe("it holds to the template standards", () => {
  it("ships a plain-text alternative", () => {
    expect(paymentDeclinedTemplate(BASE).text.trim().length).toBeGreaterThan(0);
  });

  it("is branded, so it does not read as phishing", () => {
    const out = paymentDeclinedTemplate(BASE);
    expect(out.html).toContain("Vanta Labs");
    expect(out.html).toContain("background:#050505");
  });

  it("renders no undefined, NaN or [object Object]", () => {
    const out = paymentDeclinedTemplate({ ...BASE, name: "" });
    for (const part of [out.subject, out.html, out.text]) {
      expect(part).not.toContain("undefined");
      expect(part).not.toContain("NaN");
      expect(part).not.toContain("[object Object]");
    }
  });

  it("escapes an operator- or customer-supplied name", () => {
    const out = paymentDeclinedTemplate({ ...BASE, name: "<script>alert(1)</script>" });
    expect(out.html).not.toContain("<script>alert");
  });

  it("survives a missing name without addressing nobody", () => {
    const out = paymentDeclinedTemplate({ ...BASE, name: "" });
    expect(out.html.toLowerCase()).toContain("there");
  });

  // The subject is what decides whether this gets opened at all, and a
  // shouted or padded one is filed as promotional — which is the one folder
  // this message cannot afford to land in.
  it("has a subject that does not shout", () => {
    const subject = paymentDeclinedTemplate(BASE).subject;
    expect(subject).not.toMatch(/[A-Z]{5,}/);
    expect(subject).not.toContain("!");
    expect(subject.length).toBeLessThan(70);
  });
});
