import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// A FRAUD CHECK THAT COULD NEVER FIRE ON A REAL CARD ORDER.
//
// detectCommissionFraudSignal flags an ambassador commission for review when the
// same customer email or the same shipping address has been used three or more
// times under one referral code — the self-dealing / duplicate-account pattern.
// It reads those two identities from its inputs and does nothing at all without
// them:
//
//     if (input.customerEmail) { ...count matches... }
//     normalizeAddressKey(address, city, postcode) -> "||" -> skipped
//
// The card lane passed them as `eventPayload.customer?.email` and
// `eventPayload.customer?.address`. A real processor's callback carries a
// CHARGE, not a shopper: there is no top-level `customer` on a live VeyraGate
// envelope, and only our own mock gateway populates one — by reading these very
// columns back out of the database, which is exactly why it never showed up in
// testing.
//
// So on every live card order both were undefined, both branches were skipped,
// and the heuristic returned "not flagged" without counting anything. The
// manual/admin lane, twelve hundred lines up, reads the same fields off the
// order row and works correctly — the two lanes had silently diverged.
//
// The identical bug was already found and fixed for `ambassadorId` and
// `referralCode` on the very same call, with a comment saying attribution must
// come from the authoritative order row rather than the provider's echoed
// payload. The identity fields the fraud signal needs were left behind.
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(join(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

/** The ensureCommissionRecord call in the CARD lane, and nothing else. */
const cardLaneCall = (() => {
  // The card lane is the one inside the paid side-effects block; the manual lane
  // lives in finalizeManualPayment far above it.
  const marker = SOURCE.lastIndexOf("await ensureCommissionRecord({");
  expect(marker).toBeGreaterThan(-1);
  return SOURCE.slice(marker, SOURCE.indexOf("});", marker));
})();

describe("the card lane feeds the fraud signal the identity it needs", () => {
  it("reads the customer email from the order row, not from the processor's payload", () => {
    expect(cardLaneCall).toMatch(/customerEmail:\s*orderRecord\?\.customer_email/);
  });

  it("reads the shipping address from the order row", () => {
    expect(cardLaneCall).toMatch(/shippingAddress:\s*orderRecord\?\.shipping_address/);
  });

  it("reads city and postal code from the order row too", () => {
    // The address comparison is address + city + postcode; taking one from the
    // row and two from an absent payload would make every address look distinct.
    expect(cardLaneCall).toMatch(/city:\s*orderRecord\?\.city/);
    expect(cardLaneCall).toMatch(/postalCode:\s*orderRecord\?\.postal_code/);
  });

  it("keeps the payload only as the fallback for a webhook that beats the order row", () => {
    // Same shape the attribution fields already use on this call: row first,
    // payload second. Dropping the payload entirely would break the
    // webhook-before-order case the comment above the call describes.
    expect(cardLaneCall).toMatch(/customerEmail:[^,]*eventPayload\.customer\?\.email/);
    expect(cardLaneCall).toMatch(/shippingAddress:[^,]*eventPayload\.customer\?\.address/);
  });

  it("does not take any of them from the payload FIRST", () => {
    // The defect in one assertion.
    expect(cardLaneCall).not.toMatch(/customerEmail:\s*eventPayload\.customer\?\.email/);
    expect(cardLaneCall).not.toMatch(/shippingAddress:\s*eventPayload\.customer\?\.address/);
    expect(cardLaneCall).not.toMatch(/city:\s*eventPayload\.customer\?\.city/);
    expect(cardLaneCall).not.toMatch(/postalCode:\s*eventPayload\.customer\?\.postalCode/);
  });

  it("still reads attribution from the row, which was fixed earlier and must stay", () => {
    expect(cardLaneCall).toMatch(/ambassadorId:\s*orderRecord\?\.ambassador_id/);
    expect(cardLaneCall).toMatch(/referralCode:\s*orderRecord\?\.referral_code/);
  });
});

describe("the two lanes agree about where identity comes from", () => {
  it("the manual lane reads the order row, as it always did", () => {
    const manual = SOURCE.slice(SOURCE.indexOf("export async function finalizeManualPayment"));
    const call = manual.slice(manual.indexOf("ensureCommissionRecord({"), manual.indexOf("});", manual.indexOf("ensureCommissionRecord({")));
    expect(call).toMatch(/customerEmail:\s*order\.customer_email/);
    expect(call).toMatch(/shippingAddress:\s*order\.shipping_address/);
  });
});

describe("the heuristic itself is unchanged", () => {
  it("still does nothing without an identity, which is why the wiring mattered", async () => {
    const source = readFileSync(join(process.cwd(), "src/lib/ambassador-commission.ts"), "utf8");
    expect(source).toMatch(/if \(input\.customerEmail\)/);
    // The address branch is guarded on the normalised key being non-empty
    // rather than on the raw field, which is the same thing: with no address,
    // city or postcode the key is "||" and the branch is skipped.
    expect(source).toMatch(/normalizedAddress\.replaceAll\("\|", ""\)\.length > 0/);
    // Flags for review; never blocks the sale or the commission outright.
    expect(source).toMatch(/flags \(never/);
    expect(source).toMatch(/never blocks the customer's sale/);
  });
});
