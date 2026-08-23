import { describe, expect, it } from "vitest";
import { isPaidBillingEvent, PAID_EVENT_TYPES } from "@/lib/membership-status";

// ---------------------------------------------------------------------------
// "HAS A SUCCEEDED BILLING EVENT" IS NOT PROOF OF PAYMENT.
//
// Every membership lifecycle operation -- cancellation, pause, resume, skip,
// tier_change -- is written to membership_billing_events with status
// "succeeded" and amount_cents 0, because the OPERATION succeeded. Only three
// event types ever move money.
//
// WHY THIS FILE EXISTS
//
// Replacing the event-type allow-list with `true` -- so a cancellation counts
// as a payment -- left all 2,662 existing tests green. An account that only
// ever failed to pay and then cancelled would read as a paying member.
// ---------------------------------------------------------------------------

const paid = { eventType: "renewal", status: "succeeded", amountCents: 2900 };

describe("what counts as money changing hands", () => {
  for (const eventType of PAID_EVENT_TYPES) {
    it(`counts a succeeded ${eventType} with a real amount`, () => {
      expect(isPaidBillingEvent({ ...paid, eventType })).toBe(true);
    });
  }

  describe("lifecycle records are not payments", () => {
    for (const eventType of ["cancellation", "pause", "resume", "skip", "tier_change"]) {
      it(`rejects a succeeded ${eventType}, even at a non-zero amount`, () => {
        // Non-zero deliberately: the amount is not what disqualifies it.
        expect(isPaidBillingEvent({ eventType, status: "succeeded", amountCents: 2900 })).toBe(false);
      });
    }

    it("rejects an unknown future event type rather than assuming it paid", () => {
      expect(isPaidBillingEvent({ ...paid, eventType: "some_new_event" })).toBe(false);
    });
  });

  describe("the other two conditions still hold", () => {
    for (const status of ["failed", "pending", "refunded", ""]) {
      it(`rejects a ${status || "(empty)"} renewal`, () => {
        expect(isPaidBillingEvent({ ...paid, status })).toBe(false);
      });
    }

    for (const amountCents of [0, -100]) {
      it(`rejects a renewal of ${amountCents} cents`, () => {
        expect(isPaidBillingEvent({ ...paid, amountCents })).toBe(false);
      });
    }
  });
});
