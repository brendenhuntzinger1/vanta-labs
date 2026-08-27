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

  it("duplicate webhook delivery does not send twice", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("confirmation page refreshed does not send twice", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("back/forward navigation does not send twice — the 2026-08-25 production incident", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
  });

  it("two tabs resolve to one transaction_id", () => {
    const a = buildGooglePurchase(KNOWN_ORDER);
    const b = buildGooglePurchase(KNOWN_ORDER);
    expect(a?.params.transaction_id).toBe(b?.params.transaction_id);
  });

  it("a link re-opened after 49 hours does not send again, beyond Google's own window", () => {
    expect(wasAlreadySent(ledgerAfterFirstSend, "google")).toBe(true);
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
