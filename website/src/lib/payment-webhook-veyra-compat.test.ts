import { createHmac } from "crypto";
import { describe, it, expect } from "vitest";
import {
  resolveWebhookOrderId,
  getOrderStatusForEventType,
  isRecognisedMoneyEvent,
} from "@/lib/payment-webhook";
import { verifyTimestampedSignature, LivePaymentProvider } from "@/lib/payment-provider";

// VeyraGate signs `t=<unix>,v1=<hex>` over `${t}.${rawBody}` (Stripe-style,
// replay-bounded). The pre-existing internal scheme is a bare hex HMAC over the
// body alone. Both hit this verifier, so it has to speak both — a live delivery
// was rejected outright until it did.
describe("verifyTimestampedSignature (VeyraGate scheme)", () => {
  const SECRET = "whsec_test";
  const BODY = '{"id":"evt_1","type":"charge.succeeded"}';
  const header = (t: number, body = BODY, secret = SECRET) =>
    `t=${t},v1=` + createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyTimestampedSignature(BODY, header(1700000000), SECRET, 1700000000)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyTimestampedSignature('{"id":"evt_2"}', header(1700000000), SECRET, 1700000000)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyTimestampedSignature(BODY, header(1700000000), "other", 1700000000)).toBe(false);
  });

  it("bounds replay in both directions", () => {
    expect(verifyTimestampedSignature(BODY, header(1700000000), SECRET, 1700000401)).toBe(false);
    expect(verifyTimestampedSignature(BODY, header(1700000401), SECRET, 1700000000)).toBe(false);
    expect(verifyTimestampedSignature(BODY, header(1700000000), SECRET, 1700000299)).toBe(true);
  });

  it("rejects malformed headers without throwing", () => {
    for (const h of ["", "garbage", "t=1700000000", "v1=abc", "t=abc,v1=" + "a".repeat(64)]) {
      expect(verifyTimestampedSignature(BODY, h, SECRET, 1700000000)).toBe(false);
    }
  });
});

describe("LivePaymentProvider.verifyWebhookSignature accepts both schemes", () => {
  const SECRET = "whsec_test";
  const BODY = '{"id":"evt_1"}';
  const provider = new LivePaymentProvider();

  it("accepts VeyraGate's timestamped signature", () => {
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=` + createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex");
    expect(provider.verifyWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("still accepts the pre-existing bare hex signature", () => {
    // The internal gateway and every existing caller must keep working.
    const sig = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
    expect(provider.verifyWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects a bad signature in either shape", () => {
    expect(provider.verifyWebhookSignature(BODY, "a".repeat(64), SECRET)).toBe(false);
    expect(provider.verifyWebhookSignature(BODY, `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`, SECRET)).toBe(false);
  });
});

// VeyraGate and the internal/mock gateway describe the same event differently.
// LivePaymentProvider already opens sessions with `metadata: { order_id }` — its
// own comment says the value "round-trips to the webhook at data.metadata.order_id"
// — but the webhook side only ever read a flat top-level `orderId`. So a real card
// payment would settle nothing: the id resolves to undefined, falls through to a
// random `order-<uuid>`, matches no order, and the customer is charged while their
// order stays unpaid. These pin every shape a real sender actually uses.
describe("resolveWebhookOrderId", () => {
  it("reads the flat orderId the internal gateway sends", () => {
    expect(resolveWebhookOrderId({ orderId: "ord_123" })).toBe("ord_123");
  });

  it("reads VeyraGate's nested data.metadata.order_id", () => {
    expect(
      resolveWebhookOrderId({ data: { metadata: { order_id: "ord_456" } } }),
    ).toBe("ord_456");
  });

  it("reads the un-nested variant where the charge sits under data.object", () => {
    expect(
      resolveWebhookOrderId({ data: { object: { metadata: { order_id: "ord_789" } } } }),
    ).toBe("ord_789");
  });

  it("prefers the flat id when both are present", () => {
    // The internal gateway is unambiguous about its own field; a nested value
    // should never override it.
    expect(
      resolveWebhookOrderId({ orderId: "flat", data: { metadata: { order_id: "nested" } } }),
    ).toBe("flat");
  });

  it("returns null when no sender supplied one, rather than inventing a value", () => {
    // The caller substitutes a synthetic id so the event is still recorded, but
    // that decision belongs to the caller, not here.
    expect(resolveWebhookOrderId({})).toBeNull();
    expect(resolveWebhookOrderId({ data: {} })).toBeNull();
    expect(resolveWebhookOrderId({ data: { metadata: {} } })).toBeNull();
  });
});

// The live endpoint for this store subscribes to `charge.succeeded`, `charge.failed`,
// `charge.refunded`, `payout.paid`, `dispute.created`, `dispute.evidence_required`
// AND '*'. VeyraGate remaps `charge.*` to `payment.*` for merchants, but a '*'
// subscription surfaces the unmapped internal name — so both vocabularies arrive.
describe("getOrderStatusForEventType — VeyraGate event names", () => {
  it("marks a charge.succeeded paid, like payment.succeeded", () => {
    expect(getOrderStatusForEventType("charge.succeeded")).toBe("paid");
    expect(getOrderStatusForEventType("payment.succeeded")).toBe("paid");
  });

  it("maps the remaining charge.* aliases", () => {
    expect(getOrderStatusForEventType("charge.failed")).toBe("payment_failed");
    expect(getOrderStatusForEventType("charge.refunded")).toBe("refunded");
  });

  it("accepts both spellings of the failure event", () => {
    // The quickstart documents `payment_failed` (underscore); the drop-in script
    // emits `payment.failed` (dot). Guessing wrong records a failed charge as
    // nothing at all, so both are accepted.
    expect(getOrderStatusForEventType("payment_failed")).toBe("payment_failed");
    expect(getOrderStatusForEventType("payment.failed")).toBe("payment_failed");
  });

  it("maps Veyra's dispute.* onto the internal chargeback vocabulary", () => {
    expect(getOrderStatusForEventType("dispute.created")).toBe("refunded");
    expect(getOrderStatusForEventType("chargeback.created")).toBe("refunded");
  });
});

describe("isRecognisedMoneyEvent", () => {
  it("recognises the events that genuinely move money", () => {
    for (const t of ["charge.succeeded", "payment.succeeded", "charge.refunded", "dispute.created"]) {
      expect(isRecognisedMoneyEvent(t)).toBe(true);
    }
  });

  it("does not recognise notifications that say nothing about payment state", () => {
    // These arrive because of the '*' subscription. They must never be treated as
    // a payment state — getOrderStatusForEventType maps them to "pending_payment"
    // via its default, which would demote a PAID order to unpaid.
    for (const t of ["payout.paid", "dispute.evidence_required", "something.new", ""]) {
      expect(isRecognisedMoneyEvent(t)).toBe(false);
    }
  });
});
