import { describe, expect, it } from "vitest";

import {
  GOOGLE_ADS_CURRENCY,
  buildGoogleAdsPurchase,
  emitGoogleAdsConversion,
  googleAdsSendTo,
} from "./google-ads-events";
import { GOOGLE_ADS_PURCHASE_LABEL, GOOGLE_ADS_TAG_ID } from "./google-ads-tag-id";
import type { PaidOrder } from "./tiktok-events";

/**
 * The Google Ads purchase conversion — the pure half.
 *
 * Mirrors meta-events.test.ts, and for the same reason: the one event that
 * represents money must be decidable without a browser, so the rule that gates
 * it can be asserted directly rather than inferred from a rendered page.
 */

const paidOrder: PaidOrder = {
  orderId: "b8f1c2d3-4e5a-6789-abcd-ef0123456789",
  isPaid: true,
  amountPaid: 129.99,
  items: [{ slug: "focus-stack", productId: "p-1", quantity: 2, unitPrice: 64.995 }],
};

function store(initial: string[] = []) {
  const keys = new Set(initial);
  return {
    has: (key: string) => keys.has(key),
    mark: (key: string) => void keys.add(key),
    keys,
  };
}

describe("a conversion is only ever built from a settled payment", () => {
  it("reports nothing for an order the backend has not marked paid", () => {
    expect(buildGoogleAdsPurchase({ ...paidOrder, isPaid: false })).toBeNull();
  });

  it("reports nothing when no positive amount settled", () => {
    // A zero-value purchase is not a conversion, and reporting one would put a
    // $0 sale into the bidding data the account optimises against.
    expect(buildGoogleAdsPurchase({ ...paidOrder, amountPaid: 0 })).toBeNull();
    expect(buildGoogleAdsPurchase({ ...paidOrder, amountPaid: -5 })).toBeNull();
  });

  it("reports nothing for an order with no id to transact against", () => {
    expect(buildGoogleAdsPurchase({ ...paidOrder, orderId: "" })).toBeNull();
  });
});

describe("what a paid order reports", () => {
  it("carries the settled amount and the currency it settled in", () => {
    const conversion = buildGoogleAdsPurchase(paidOrder);
    expect(conversion?.value).toBe(129.99);
    expect(conversion?.currency).toBe(GOOGLE_ADS_CURRENCY);
  });

  it("rounds to the cent rather than sending a float Google would round for us", () => {
    const conversion = buildGoogleAdsPurchase({ ...paidOrder, amountPaid: 10.005 });
    expect(conversion?.value).toBe(10.01);
  });

  it("names the order as the transaction, which is what stops a reopened link counting twice", () => {
    // Google deduplicates on transaction_id. A confirmation link forwarded,
    // bookmarked or reopened a week later must land as the SAME sale, and the
    // order id is the only value that is stable across all of those.
    const conversion = buildGoogleAdsPurchase(paidOrder);
    expect(conversion?.transactionId).toBe(paidOrder.orderId);
  });

  it("sends to the purchase conversion action of this account", () => {
    const conversion = buildGoogleAdsPurchase(paidOrder);
    expect(conversion?.sendTo).toBe(`${GOOGLE_ADS_TAG_ID}/${GOOGLE_ADS_PURCHASE_LABEL}`);
  });

  it("carries no customer identity of any kind", () => {
    // Enhanced Conversions is offered on the same Google Ads screen as the
    // snippet and takes a raw email address. Nothing here builds that field, so
    // the absence is structural rather than a matter of remembering.
    const conversion = buildGoogleAdsPurchase(paidOrder);
    expect(Object.keys(conversion ?? {}).sort()).toEqual(
      ["currency", "dedupeKey", "sendTo", "transactionId", "value"],
    );
  });
});

describe("a malformed conversion action is refused rather than guessed at", () => {
  it("composes a send_to from a well-formed tag id and label", () => {
    expect(googleAdsSendTo("AW-18412722313", "ERwECOzToPscEImx78tE")).toBe(
      "AW-18412722313/ERwECOzToPscEImx78tE",
    );
  });

  it("refuses a tag id that is not a Google Ads id", () => {
    // Both halves come from operator-settable env vars, so neither is trusted.
    expect(googleAdsSendTo("G-ABCDEF1234", "ERwECOzToPscEImx78tE")).toBeNull();
    expect(googleAdsSendTo("AW-123'); alert(1); //", "ERwECOzToPscEImx78tE")).toBeNull();
  });

  it("refuses a label that is not a conversion label", () => {
    expect(googleAdsSendTo("AW-18412722313", "")).toBeNull();
    expect(googleAdsSendTo("AW-18412722313", "has spaces")).toBeNull();
    expect(googleAdsSendTo("AW-18412722313", "quote'injection")).toBeNull();
  });

  it("builds no conversion at all when the action cannot be composed", () => {
    // Refusing to fire is the right direction: a send_to Google does not
    // recognise is a conversion silently attributed to nothing.
    expect(buildGoogleAdsPurchase(paidOrder, { sendTo: null })).toBeNull();
  });
});

describe("emitting is guarded by the same durable key the other platforms use", () => {
  it("passes gtag the event shape Google's own snippet documents", () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [];
    const fired = emitGoogleAdsConversion(
      buildGoogleAdsPurchase(paidOrder),
      (command, name, params) => void calls.push([command, name, params]),
      store(),
    );

    expect(fired).toBe(true);
    expect(calls).toHaveLength(1);
    const [command, name, params] = calls[0];
    expect(command).toBe("event");
    expect(name).toBe("conversion");
    expect(params).toEqual({
      send_to: `${GOOGLE_ADS_TAG_ID}/${GOOGLE_ADS_PURCHASE_LABEL}`,
      value: 129.99,
      currency: "USD",
      transaction_id: paidOrder.orderId,
    });
  });

  it("refuses a second emit for an order already marked", () => {
    const seen = store([`google-ads-purchase:${paidOrder.orderId}`]);
    const calls: unknown[] = [];
    const fired = emitGoogleAdsConversion(
      buildGoogleAdsPurchase(paidOrder),
      (...args) => void calls.push(args),
      seen,
    );
    expect(fired).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("marks the order once it has fired, so the next mount is silent", () => {
    const seen = store();
    emitGoogleAdsConversion(buildGoogleAdsPurchase(paidOrder), () => {}, seen);
    expect(seen.has(`google-ads-purchase:${paidOrder.orderId}`)).toBe(true);
  });

  it("does nothing at all when handed no conversion", () => {
    const calls: unknown[] = [];
    expect(emitGoogleAdsConversion(null, (...args) => void calls.push(args), store())).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
