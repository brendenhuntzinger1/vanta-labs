import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FREE_SHIPPING_THRESHOLD } from "@/lib/shipping";
import { isUnderpaidTotal } from "@/lib/quote-order";
import { resolveWebhookPaidAmount } from "@/lib/payment-webhook";

// ---------------------------------------------------------------------------
// EVERY AMOUNT IS THE SAME AMOUNT.
//
// Until 2026-09-09 this store had never taken an order of $200 or more. Seven
// tried; all seven died. The largest payment that had ever succeeded was
// $194.98, and a $200 boundary that sharp invites exactly one question: is it
// ours?
//
// It was not. The cause was processor-side 3-D Secure, and the store's only
// number anywhere near $200 is FREE_SHIPPING_THRESHOLD, which is keyed on the
// SUBTOTAL and decides the cost of shipping — it never gates a charge, never
// branches the payment path, and applies identically either side of the line.
//
// That was established by reading every amount comparison on the path. This file
// turns that reading into something that stays true: a reintroduced gate
// anywhere between the quote, the order row, the amount handed to the processor
// and the webhook's own assertion would have to break one of these.
//
// The amounts are the real ones. $269.35 is David's order — the first payment at
// or above $200 this store ever settled, and the first that had ever reached an
// issuer.
// ---------------------------------------------------------------------------

/** Real and boundary totals, in dollars. */
const AMOUNTS = [
  1, 9.99, 49.5, 99.95,
  194.98,   // the largest that had ever succeeded before the fix
  199.98, 199.99,
  200, 200.01,
  249.9, 269.35,  // VL-4AFCDF39 / VL-D56BA5B4 — declined, then paid
  349.99, 500, 620.4, 999.99, 1234.56,
];

describe("dollars reach the processor as exact cents", () => {
  it("converts every named amount without a rounding drift", () => {
    // payment-service sends `Math.round(finalTotal * 100)` and the provider
    // passes it straight through as amount_cents. A half-cent error here is a
    // charge that disagrees with the order row, which the webhook then holds out
    // of fulfilment — so the conversion has to be exact at every one of these.
    for (const dollars of AMOUNTS) {
      const cents = Math.round(dollars * 100);
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBe(Number((dollars * 100).toFixed(0)));
      expect(cents / 100).toBeCloseTo(dollars, 10);
    }
  });

  it("round-trips a processor's minor units back to the same dollars", () => {
    for (const dollars of AMOUNTS) {
      const cents = Math.round(dollars * 100);
      expect(resolveWebhookPaidAmount({ data: { object: { amount_captured_cents: cents } } })).toBe(dollars);
    }
  });

  it("refuses a non-integer or non-positive amount before it reaches the card", () => {
    const provider = readFileSync(join(process.cwd(), "src/lib/payment-provider.ts"), "utf8");
    expect(provider).toMatch(/!Number\.isInteger\(amountCents\) \|\| amountCents <= 0/);
  });
});

describe("the underpayment guard behaves identically on both sides of $200", () => {
  it("accepts a client total that matches, at every amount", () => {
    for (const dollars of AMOUNTS) {
      expect(isUnderpaidTotal(dollars, dollars)).toBe(false);
    }
  });

  it("rejects a short total by the same margin at every amount", () => {
    for (const dollars of AMOUNTS) {
      expect(isUnderpaidTotal(dollars - 0.02, dollars)).toBe(true);
    }
  });

  it("tolerates a one-cent float artefact at every amount, and no more", () => {
    for (const dollars of AMOUNTS) {
      expect(isUnderpaidTotal(dollars - 0.01, dollars)).toBe(false);
    }
  });

  it("never treats crossing $200 as a reason to behave differently", () => {
    // The whole claim in one assertion: the guard's verdict depends on the gap,
    // not on the magnitude.
    const below = isUnderpaidTotal(199.99, 199.99);
    const at = isUnderpaidTotal(200, 200);
    const above = isUnderpaidTotal(200.01, 200.01);
    expect(new Set([below, at, above]).size).toBe(1);
  });
});

describe("the only number near $200 is about shipping, not about charging", () => {
  it("is the free-shipping threshold and nothing else", () => {
    expect(FREE_SHIPPING_THRESHOLD).toBe(200);
  });

  it("does not appear on the payment path at all", () => {
    // A gate reintroduced anywhere between the quote and the processor would
    // have to be written as a comparison in one of these files.
    const files = [
      "src/lib/payment-service.ts",
      "src/lib/payment-provider.ts",
      "src/lib/payment-webhook.ts",
      "src/lib/checkout-poll-decision.ts",
      "src/lib/inventory-reservation.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8")
        // Comments discuss the $200 wall at length; the rule is about code.
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
        .join("\n");
      expect(source, `${file} compares an amount against 200`).not.toMatch(/[<>]=?\s*200\b/);
      expect(source, `${file} imports the free-shipping threshold`).not.toMatch(/FREE_SHIPPING_THRESHOLD/);
    }
  });

  it("is keyed on the SUBTOTAL, so it cannot depend on tax or shipping", () => {
    const shipping = readFileSync(join(process.cwd(), "src/lib/shipping.ts"), "utf8");
    expect(shipping).toMatch(/subtotal/i);
  });
});

describe("the amount assertion on the webhook is symmetric", () => {
  // The webhook's own rule, in cents.
  //
  // It was written on dollars as `Math.abs(event - recorded) > 0.01`, which is
  // not the rule it looks like: binary floating point holds neither operand
  // exactly, so a difference of precisely one cent falls on either side of the
  // threshold depending on the magnitudes. 194.99 − 194.98 evaluates to
  // 0.010000000000019327 and trips it; 269.36 − 269.35 evaluates to
  // 0.009999999999990905 and does not. On the
  // flat/internal shape a trip HOLDS the order out of fulfilment, so that was a
  // real parcel stopped by an artefact of the representation.
  const disagrees = (event: number, recorded: number) =>
    Math.abs(Math.round(event * 100) - Math.round(recorded * 100)) > 1;

  it("compares the same way at every amount, with a one-cent tolerance", () => {
    for (const dollars of AMOUNTS) {
      expect(disagrees(dollars, dollars)).toBe(false);
      expect(disagrees(dollars + 0.01, dollars)).toBe(false);
      expect(disagrees(dollars - 0.01, dollars)).toBe(false);
      expect(disagrees(dollars + 0.02, dollars)).toBe(true);
      expect(disagrees(dollars + 1, dollars)).toBe(true);
      expect(disagrees(dollars - 1, dollars)).toBe(true);
    }
  });

  it("is the rule the webhook actually applies", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");
    expect(source).toContain("Math.abs(Math.round(eventAmount * 100) - Math.round(recordedAmount * 100)) > 1");
    expect(source).not.toContain("Math.abs(eventAmount - recordedAmount) > 0.01");
  });

  it("was inconsistent under the old rule, penny for penny", () => {
    // Two differences of exactly one cent, one of which the dollar comparison
    // called a mismatch and the other of which it did not. The one it flagged is
    // $194.98 — the largest payment this store had ever taken before the 3DS fix.
    expect(Math.abs(194.99 - 194.98) > 0.01).toBe(true);   // held out of fulfilment
    expect(Math.abs(269.36 - 269.35) > 0.01).toBe(false);  // let through
    // In cents both are one cent apart, and both are within tolerance.
    expect(disagrees(194.99, 194.98)).toBe(false);
    expect(disagrees(269.36, 269.35)).toBe(false);
  });

  it("treats a missing amount as 'no opinion', never as zero", () => {
    // The reconcile sweep replays payment.succeeded with no amount on purpose.
    // Reading that as 0 would flag a mismatch on every recovered order.
    expect(resolveWebhookPaidAmount({})).toBeNull();
    expect(resolveWebhookPaidAmount({ data: { object: {} } })).toBeNull();
    expect(resolveWebhookPaidAmount({ data: { object: { amount_cents: 0 } } })).toBeNull();
  });
});
