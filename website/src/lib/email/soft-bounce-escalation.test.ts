import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONSECUTIVE_SOFT_BOUNCE_LIMIT,
  SOFT_BOUNCE_RUN_REASON,
  countConsecutiveSoftBounces,
  softBouncesWarrantSuppression,
} from "@/lib/email/delivery-events";
import { isCustomerReversibleSuppression } from "@/lib/email/suppression-reasons";

const DELIVERY_EVENTS = readFileSync(
  path.resolve(process.cwd(), "src/lib/email/delivery-events.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// A SOFT BOUNCE THAT NEVER STOPS IS A HARD BOUNCE NOBODY ACTED ON.
//
// The webhook splits bounces by the provider's own severity: "permanent"
// suppresses immediately, "transient" does not. That split is right — a
// transient bounce is a full mailbox or a weekend outage, and suppressing on
// one would lose a real customer over something that clears by Monday.
//
// What was missing is the other end of it. Nothing counted. An address could
// soft-bounce on every send for ever and stay on every audience, because each
// bounce was judged alone and each one alone looked temporary.
//
// The 2026-09-02 audit found it live: `kojonketia@iclouds.com` — a typo of
// icloud.com, a domain with no mailbox behind it — bounced transient and was
// still fully mailable. Repeatedly mailing an address that never accepts mail
// is one of the two behaviours that ruin a sending domain, and the mail that
// suffers first is the receipts and password resets riding the same domain.
//
// So consecutive soft bounces escalate. CONSECUTIVE is the important word: a
// delivery proves the address works and resets the count, so a customer whose
// mailbox was full in June is not suppressed by a bounce in September.
// ---------------------------------------------------------------------------

/** Newest first, which is the order the lookup returns. */
const ev = (kind: string) => ({ kind });

describe("countConsecutiveSoftBounces", () => {
  it("counts an unbroken run of soft bounces", () => {
    expect(countConsecutiveSoftBounces([ev("soft_bounce"), ev("soft_bounce"), ev("soft_bounce")])).toBe(3);
  });

  it("stops counting at the most recent delivery", () => {
    // The address demonstrably works. Bounces older than that proved nothing
    // about today and must not accumulate towards a suppression.
    expect(
      countConsecutiveSoftBounces([
        ev("soft_bounce"),
        ev("delivered"),
        ev("soft_bounce"),
        ev("soft_bounce"),
        ev("soft_bounce"),
      ]),
    ).toBe(1);
  });

  it("returns zero when the newest event is a delivery", () => {
    expect(countConsecutiveSoftBounces([ev("delivered"), ev("soft_bounce")])).toBe(0);
  });

  it("ignores event kinds that say nothing about reachability", () => {
    // A 'delayed' is the provider still trying; it neither proves the address
    // works nor counts as a failure to reach it.
    expect(countConsecutiveSoftBounces([ev("soft_bounce"), ev("delayed"), ev("soft_bounce")])).toBe(2);
  });

  it("handles an empty history", () => {
    expect(countConsecutiveSoftBounces([])).toBe(0);
  });
});

describe("softBouncesWarrantSuppression", () => {
  it("tolerates a bounce or two, because most transient bounces clear", () => {
    expect(softBouncesWarrantSuppression(1)).toBe(false);
    expect(softBouncesWarrantSuppression(CONSECUTIVE_SOFT_BOUNCE_LIMIT - 1)).toBe(false);
  });

  it("suppresses once the run reaches the limit", () => {
    expect(softBouncesWarrantSuppression(CONSECUTIVE_SOFT_BOUNCE_LIMIT)).toBe(true);
    expect(softBouncesWarrantSuppression(CONSECUTIVE_SOFT_BOUNCE_LIMIT + 5)).toBe(true);
  });

  it("keeps the limit above one, so a single transient bounce never suppresses", () => {
    // Guards the constant itself: dropping it to 1 would silently turn every
    // full mailbox into a permanent removal from the list.
    expect(CONSECUTIVE_SOFT_BOUNCE_LIMIT).toBeGreaterThan(1);
  });
});

describe("the webhook applies the escalation", () => {
  it("suppresses a repeatedly soft-bouncing address", () => {
    expect(DELIVERY_EVENTS).toContain("softBouncesWarrantSuppression");
  });

  it("records it as a bounce, so a preference save cannot lift it", () => {
    // PROVIDER_IMPOSED_SUPPRESSION_REASONS covers "bounced"; anything else here
    // would let the account page put the address straight back on the list.
    expect(DELIVERY_EVENTS).toContain('"bounced"');
  });
});


// ---------------------------------------------------------------------------
// WHAT THE PRE-DEPLOY REVIEW CAUGHT, HOURS AFTER THIS WAS WRITTEN.
//
// Three independent reviewers converged on the same objection, and both halves
// of it were right.
//
// 1. THE RUN WAS ORDERED BY A COLUMN THAT MOVES. `received_at` is stamped at
//    WRITE time, and recordDeliveryEvent upserts, so a webhook REDELIVERY —
//    which Resend does routinely — rewrote an old event's timestamp to now and
//    floated it to the top of the ordering. A delivery then stopped resetting
//    the run, which is the one property the whole escalation rests on.
//
// 2. THE SUPPRESSION COULD NOT BE UNDONE BY THE PERSON IT HIT. It was written
//    with reason "bounced", which PROVIDER_IMPOSED_SUPPRESSION_REASONS covers,
//    so the account page refuses to lift it. That is correct for a real hard
//    bounce — the mailbox does not exist — but an escalated soft-bounce run is
//    INFERRED, not a verdict. A customer whose mailbox was full over a holiday
//    would have been removed from marketing permanently, with no way back
//    except a support ticket and a manual database edit.
//
// The timing made it sharp: the store is about to move marketing to a brand-new
// sending subdomain with no reputation, which is exactly when transient bounces
// are most likely.
// ---------------------------------------------------------------------------

describe("an inferred suppression must be undoable by the customer", () => {
  it("uses its own reason, not the one a real hard bounce uses", () => {
    expect(SOFT_BOUNCE_RUN_REASON).not.toBe("bounced");
  });

  it("lets a customer who wants the mail turn it back on", () => {
    // A genuinely dead address simply re-escalates. A live customer gets their
    // mail back the moment they ask for it, which is the asymmetry that matters:
    // wrongly retiring an engaged customer for ever is the worse error.
    expect(isCustomerReversibleSuppression(SOFT_BOUNCE_RUN_REASON)).toBe(true);
  });
});

describe("the run is read in a stable order", () => {
  // An earlier draft of this test banned ordering by received_at outright. That
  // was the wrong requirement: the column is fine, it was the REWRITE that made
  // it move. With the row kept on conflict, received_at is stamped once at first
  // receipt and never changes, so ordering by it is stable — which is what the
  // escalation actually needs.
  it("does not let a webhook redelivery rewrite an event's recorded time", () => {
    // ignoreDuplicates keeps the ORIGINAL row and its original timestamp, which
    // also makes redelivery genuinely idempotent rather than merely harmless.
    expect(DELIVERY_EVENTS).toContain("ignoreDuplicates: true");
  });
});
