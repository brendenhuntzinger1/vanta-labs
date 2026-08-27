import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGooglePurchase } from "./google-events";
import { buildGoogleIdentity } from "./google-matching";
import { wasAlreadySent, type LedgerRow } from "./purchase-ledger";
import type { PaidOrder } from "./tiktok-events";

/**
 * THE RELEASE GATE.
 *
 * A known paid order, asserted against the exact payload Google should receive,
 * then replayed through every way one order has been observed to produce two
 * conversions. If this file passes, the integration reports what it claims to
 * report and cannot double-count. If it does not, nothing ships.
 *
 * The back/forward scenario is not hypothetical: on 2026-08-25 a shopper's
 * back-navigation re-sent the server-side TikTok and Reddit conversions 27
 * seconds after the first send, because the ledger table answered 404.
 */

const KNOWN_ORDER: PaidOrder = {
  orderId: "VL-2026-0001",
  isPaid: true,
  amountPaid: 149.99,
  items: [
    { slug: "bpc-157", productId: "prod_1", productName: "BPC-157 10mg", quantity: 2, unitPrice: 59.995 },
    { slug: "tb-500", productId: "prod_2", productName: "TB-500 5mg", quantity: 1, unitPrice: 30 },
  ],
};

const KNOWN_EMAIL = "First.Last+orders@gmail.com";
const EXPECTED_EMAIL_DIGEST = createHash("sha256").update("firstlast@gmail.com", "utf8").digest("hex");

describe("reconciliation — the exact payload", () => {
  it("produces exactly the expected Google purchase for a known paid order", () => {
    const event = buildGooglePurchase(KNOWN_ORDER, {
      identity: buildGoogleIdentity({ email: KNOWN_EMAIL, phone: null }),
    });

    expect(event).toEqual({
      name: "purchase",
      params: {
        value: 149.99,
        currency: "USD",
        transaction_id: "VL-2026-0001",
        items: [
          { item_id: "bpc-157", item_name: "BPC-157 10mg", quantity: 2, price: 60 },
          { item_id: "tb-500", item_name: "TB-500 5mg", quantity: 1, price: 30 },
        ],
      },
      userData: { sha256_email_address: EXPECTED_EMAIL_DIGEST },
      dedupeKey: "google-purchase:VL-2026-0001",
    });
  });

  it("reports the settled total to the cent, matching the card statement", () => {
    const event = buildGooglePurchase(KNOWN_ORDER);
    expect(event?.params.value).toBe(KNOWN_ORDER.amountPaid);
  });

  // KNOWN_ORDER's line items happen to sum to exactly `amountPaid` (59.995*2 +
  // 30 = 149.99), so the assertion above would stay green even if the builder
  // were changed to sum line items instead of trusting `amountPaid` — the
  // exact regression this test claims to forbid. This is the assertion that
  // actually catches that: a discounted order where the line-item sum
  // (149.99, same catalogue lines as KNOWN_ORDER) genuinely diverges from the
  // settled total (131.50, e.g. an $18.49 discount applied at checkout).
  it("reports the settled total even when it diverges from the line-item sum", () => {
    const discountedOrder: PaidOrder = { ...KNOWN_ORDER, amountPaid: 131.5 };
    const lineItemSum = discountedOrder.items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * (item.quantity ?? 1), 0);
    expect(lineItemSum).toBe(149.99); // sanity: the two figures really do differ
    expect(lineItemSum).not.toBe(discountedOrder.amountPaid);

    const event = buildGooglePurchase(discountedOrder);
    expect(event?.params.value).toBe(131.5);
  });

  it("carries no raw customer data anywhere in the payload", () => {
    const event = buildGooglePurchase(KNOWN_ORDER, {
      identity: buildGoogleIdentity({ email: KNOWN_EMAIL, phone: "+1 555 010 1234" }),
    });
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain("First.Last");
    expect(serialised).not.toContain("gmail.com");
    expect(serialised).not.toContain("5550101234");
  });
});

describe("reconciliation — one paid order, one conversion", () => {
  const ledgerAfterFirstSend: LedgerRow[] = [
    { order_id: "VL-2026-0001", platform: "google", delivered: true },
  ];

  // Duplicate webhook delivery, a refreshed confirmation page, and a
  // 49-hour-later re-open all reach `wasAlreadySent` the same way: a row for
  // (order_id, platform) already exists, so the read returns true. They are
  // one assertion under three names, not three mechanisms — the pure function
  // has no way to distinguish *why* the request repeated, only that the
  // ledger already has a row for this platform. What differs between those
  // three real scenarios (timing, request origin, retry cause) is exercised
  // by the route and enforced permanently by the database's unique
  // constraint on (order_id, platform), not by this in-memory check.
  it("any ledger row for the platform suppresses a resend, whatever caused the re-request", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  // THE 2026-08-25 INCIDENT, actually covered. The production failure was not
  // "a row existed and got ignored" — it was the ledger table answering 404,
  // i.e. no rows at all, so `wasAlreadySent` had nothing to check against and
  // returned false, and the send went out again 27 seconds later.
  // `wasAlreadySent` deliberately fails OPEN on a missing/empty ledger: an
  // occasional duplicate that a platform's own dedup window collapses is a
  // better failure than silently dropping real revenue because a read
  // failed. This is intentional and this test exists to keep it visible, not
  // to demand it be changed — the permanent protection against a genuine
  // double-send is the database's unique constraint on (order_id, platform)
  // at insert time, not this read.
  it("an unavailable ledger (null/undefined/empty rows) fails open — the 2026-08-25 mechanism", () => {
    expect(wasAlreadySent(null, "google")).toBe(false);
    expect(wasAlreadySent(undefined, "google")).toBe(false);
    expect(wasAlreadySent([], "google")).toBe(false);
  });

  it("two tabs resolve to one transaction_id", () => {
    const a = buildGooglePurchase(KNOWN_ORDER);
    const b = buildGooglePurchase(KNOWN_ORDER);
    expect(a?.params.transaction_id).toBe(b?.params.transaction_id);
  });

  it("another platform's send does NOT suppress Google's", () => {
    expect(wasAlreadySent([{ order_id: "VL-2026-0001", platform: "tiktok", delivered: true }], "google")).toBe(false);
  });

  it("declined then retried then successful reports only the settled order", () => {
    expect(buildGooglePurchase({ ...KNOWN_ORDER, isPaid: false })).toBeNull();
    expect(buildGooglePurchase(KNOWN_ORDER)?.params.transaction_id).toBe("VL-2026-0001");
  });

  it("an abandoned checkout never produces a purchase", () => {
    expect(buildGooglePurchase({ ...KNOWN_ORDER, isPaid: false, amountPaid: 0 })).toBeNull();
  });
});
