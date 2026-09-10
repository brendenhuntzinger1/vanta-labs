import { describe, expect, it } from "vitest";

import { resolveWebhookCaptureSessionId } from "@/lib/payment-webhook";

// ---------------------------------------------------------------------------
// TWO CHARGES, ONE ORDER, AND NOBODY TOLD.
//
// The atomic paid-flip carries `.neq("payment_status", "paid")`, so a second
// success event on an order that is already paid updates zero rows and skips
// every side effect. For a REDELIVERY of the same charge that is exactly right:
// one commission, one email, one decrement.
//
// The same zero rows come back when the processor has captured the card a
// SECOND time, and that case was absorbed in silence. The store keeps one order
// at one amount; the customer is out two payments. Every surface downstream —
// the order page, the receipt, the invoice, the admin row, the ledger — reads
// the single recorded amount, so there is no way to notice from inside the
// system at all.
//
// It is reachable here. resumeExistingOrder mints a FRESH processor session for
// an order that is not yet paid and moves payment_id onto it, and nothing on our
// side voids the session it replaced — whether the processor does is not
// something we know. So a shopper with the earlier card form still open in
// another tab may hold a second submittable form for one order. That is the same
// "just try again" behaviour that produced David's and Andrew's repeat attempts
// on 2026-09-08.
//
// The session id is the only field that separates one capture from another. The
// envelope id differs per delivery — the dedupe keyed on it cannot tell a retry
// from a real second charge, which is precisely why this gap existed.
// ---------------------------------------------------------------------------

describe("resolveWebhookCaptureSessionId", () => {
  it("reads the flat paymentId the internal gateway and the reconcile sweep send", () => {
    expect(resolveWebhookCaptureSessionId({ paymentId: "vs_first" })).toBe("vs_first");
  });

  it("reads a live VeyraGate charge object's session metadata", () => {
    expect(resolveWebhookCaptureSessionId({
      data: { object: { metadata: { veyragate_session_id: "vs_live" } } },
    })).toBe("vs_live");
  });

  it("reads it un-nested too, because the charge has been seen both ways", () => {
    expect(resolveWebhookCaptureSessionId({
      data: { metadata: { veyragate_session_id: "vs_flat" } },
    })).toBe("vs_flat");
  });

  it("returns null when the delivery names no session, so nothing is inferred", () => {
    // A delivery with no session id is not evidence of a duplicate. Treating
    // absent as "different" would fire this alert on every ordinary redelivery
    // from a sender that omits it.
    expect(resolveWebhookCaptureSessionId({})).toBeNull();
    expect(resolveWebhookCaptureSessionId({ paymentId: "   " })).toBeNull();
    expect(resolveWebhookCaptureSessionId({ data: { object: { metadata: {} } } })).toBeNull();
  });

  it("prefers the flat field, so the reconcile sweep's own replay matches the stored id", () => {
    // The sweep sends paymentId = the order's own payment_id. If a nested field
    // ever disagreed, preferring the nested one would make the sweep look like a
    // second capture on every recovered order.
    expect(resolveWebhookCaptureSessionId({
      paymentId: "vs_stored",
      data: { object: { metadata: { veyragate_session_id: "vs_other" } } },
    })).toBe("vs_stored");
  });

  it("does not confuse the charge id with the session id", () => {
    // vtxn_… is the charge; vs_… is the session. Comparing a charge id against a
    // stored session id would differ on EVERY live redelivery and cry duplicate
    // on ordinary traffic.
    expect(resolveWebhookCaptureSessionId({
      data: { object: { id: "vtxn_abc", metadata: { veyragate_session_id: "vs_abc" } } },
    } as Parameters<typeof resolveWebhookCaptureSessionId>[0])).toBe("vs_abc");
  });
});
