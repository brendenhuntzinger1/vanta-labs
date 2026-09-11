import { describe, expect, it } from "vitest";

import {
  MAX_VERIFY_ATTEMPTS,
  RESUBSCRIBE_COOLDOWN_MS,
  canSendMarketing,
  canSendTransactional,
  describeMarketingEligibility,
  newSubscriber,
  transition,
  type SmsEvent,
  type SubscriberState,
} from "@/lib/sms/state";

// ---------------------------------------------------------------------------
// Invariants 3 and 4 in the M2 matrix, and the one that matters most:
//
//     A VERIFIED NUMBER IS NOT A MARKETING SUBSCRIBER.
//
// The store already holds ~33 numbers that are real, belong to real customers,
// and carry no marketing consent. Every one of them would pass a naive "do we
// have a good number for this person" check. So the tests below spend most of
// their effort proving that possession alone never opens the marketing path,
// from every direction it could be reached.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-11T12:00:00.000Z");
const day = 24 * 60 * 60 * 1000;

/** Drive a subscriber through a sequence, asserting each step is accepted. */
function drive(events: Array<[SmsEvent, number?]>, from = newSubscriber()): SubscriberState {
  let state = from;
  for (const [event, now] of events) {
    const result = transition(state, event, { now: now ?? T0 });
    if (!result.ok) throw new Error(`unexpected refusal on ${event}: ${result.reason}`);
    state = result.next;
  }
  return state;
}

const ACTIVE = () => drive([["verify_sent"], ["verified"], ["marketing_granted"], ["double_optin_confirmed"]]);

describe("a verified number is not a marketing subscriber", () => {
  it("cannot be marketed to after verification alone", () => {
    const state = drive([["verify_sent"], ["verified"]]);
    expect(state.status).toBe("verified");
    expect(state.marketingConsent).toBe(false);
    expect(canSendMarketing(state)).toBe(false);
  });

  it("cannot be marketed to with consent but no confirmation reply", () => {
    const state = drive([["verify_sent"], ["verified"], ["marketing_granted"]]);
    expect(state.marketingConsent).toBe(true);
    expect(state.doubleOptinConfirmedAt).toBeNull();
    expect(canSendMarketing(state)).toBe(false);
  });

  it("treats every spelling of 'not confirmed' as not confirmed", () => {
    // A column that was never written reads back as undefined, not null, and
    // the original strict `!== null` check let that through. This is the
    // regression guard for that bug.
    for (const absent of [null, undefined, ""]) {
      const state = { ...ACTIVE(), doubleOptinConfirmedAt: absent as string | null };
      expect(canSendMarketing(state), `${String(absent)} should not be sendable`).toBe(false);
      expect(describeMarketingEligibility(state)).toBe("Awaiting confirmation reply");
    }
  });

  it("requires all three conditions together", () => {
    expect(canSendMarketing(ACTIVE())).toBe(true);

    // Remove each condition in turn; each alone is disqualifying.
    expect(canSendMarketing({ ...ACTIVE(), status: "pending" })).toBe(false);
    expect(canSendMarketing({ ...ACTIVE(), marketingConsent: false })).toBe(false);
    expect(canSendMarketing({ ...ACTIVE(), doubleOptinConfirmedAt: null })).toBe(false);
  });

  it("re-verifying an opted-out number does NOT revive it", () => {
    // The tempting shortcut: they proved possession again, so surely they are
    // back? No — possession was never the thing they withdrew.
    const out = drive([["verify_sent"], ["verified"], ["marketing_granted"], ["double_optin_confirmed"], ["marketing_revoked"]]);
    const result = transition(out, "verified", { now: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("opted out");
  });

  it("a marketing grant before verification does not take effect", () => {
    const pending = newSubscriber();
    const result = transition(pending, "marketing_granted", { now: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("verified");
  });

  it("a confirmation reply cannot manufacture consent that was never given", () => {
    // Replying YES to a message is not the consent; the disclosure and the tick
    // are. Without a grant on file there is nothing to confirm.
    const verified = drive([["verify_sent"], ["verified"]]);
    const result = transition(verified, "double_optin_confirmed", { now: T0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No marketing consent on file");
  });
});

describe("opt-out is the one path that may never fail", () => {
  it("is accepted from every state, including states it makes no sense from", () => {
    const states: SubscriberState[] = [
      newSubscriber(),
      drive([["verify_sent"], ["verified"]]),
      drive([["verify_sent"], ["verified"], ["marketing_granted"]]),
      ACTIVE(),
    ];
    for (const state of states) {
      const result = transition(state, "marketing_revoked", { now: T0 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.next.status).toBe("opted_out");
        expect(canSendMarketing(result.next)).toBe(false);
      }
    }
  });

  it("is idempotent and does not move the original timestamp", () => {
    const first = transition(ACTIVE(), "marketing_revoked", { now: T0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = transition(first.next, "marketing_revoked", { now: T0 + day });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.next.optedOutAt).toBe(first.next.optedOutAt);
  });

  it("clears both the consent flag and the confirmation, not just the status", () => {
    // Leaving either set would make canSendMarketing depend on the status check
    // alone, which is exactly the single-column dependency this design avoids.
    const result = transition(ACTIVE(), "marketing_revoked", { now: T0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.marketingConsent).toBe(false);
      expect(result.next.doubleOptinConfirmedAt).toBeNull();
    }
  });
});

describe("transactional messaging survives an opt-out, deliberately", () => {
  it("still reaches an opted-out subscriber", () => {
    // Counter-intuitive and correct: a STOP to the marketing number must not
    // cost someone their shipping notifications. Two numbers, two consents.
    const out = transition(ACTIVE(), "marketing_revoked", { now: T0 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(canSendTransactional(out.next)).toBe(true);
      expect(canSendMarketing(out.next)).toBe(false);
    }
  });

  it("does not reach an unverified number", () => {
    expect(canSendTransactional(newSubscriber())).toBe(false);
  });

  it("does not reach a blocked number", () => {
    const blocked = transition(ACTIVE(), "blocked", { now: T0 });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(canSendTransactional(blocked.next)).toBe(false);
      expect(canSendMarketing(blocked.next)).toBe(false);
    }
  });
});

describe("blocked is terminal", () => {
  it("absorbs every other event", () => {
    const blocked = transition(ACTIVE(), "blocked", { now: T0 });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    for (const event of ["verified", "marketing_granted", "double_optin_confirmed", "resubscribed", "verify_sent"] as SmsEvent[]) {
      const result = transition(blocked.next, event, { now: T0 + 400 * day });
      expect(result.ok, `${event} should be refused`).toBe(false);
    }
  });

  it("revokes marketing as it blocks", () => {
    const blocked = transition(ACTIVE(), "blocked", { now: T0 });
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.next.marketingConsent).toBe(false);
  });
});

describe("resubscribe: a fresh consent, not a revival", () => {
  const optedOut = () => {
    const result = transition(ACTIVE(), "marketing_revoked", { now: T0 });
    if (!result.ok) throw new Error("setup");
    return result.next;
  };

  it("is refused inside the cooldown", () => {
    const result = transition(optedOut(), "resubscribed", { now: T0 + 5 * day });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("cooldown");
      expect(result.reason).toContain("25 day");
    }
  });

  it("is allowed once the cooldown has elapsed", () => {
    const result = transition(optedOut(), "resubscribed", { now: T0 + RESUBSCRIBE_COOLDOWN_MS });
    expect(result.ok).toBe(true);
  });

  it("returns to VERIFIED, not to subscribed — consent must be given again", () => {
    const result = transition(optedOut(), "resubscribed", { now: T0 + 31 * day });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("verified");
      expect(result.next.marketingConsent).toBe(false);
      expect(result.next.doubleOptinConfirmedAt).toBeNull();
      // The point: START alone does not resume marketing.
      expect(canSendMarketing(result.next)).toBe(false);
    }
  });

  it("counts resubscribes, so farming is visible", () => {
    const back = transition(optedOut(), "resubscribed", { now: T0 + 31 * day });
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.next.resubscribeCount).toBe(1);
  });

  it("is refused for a number that never opted out", () => {
    expect(transition(ACTIVE(), "resubscribed", { now: T0 }).ok).toBe(false);
  });
});

describe("verification attempts", () => {
  it("refuses to exhaust below the limit", () => {
    const state = drive([["verify_sent"]]);
    expect(transition(state, "verify_exhausted", { now: T0, verifyAttempts: MAX_VERIFY_ATTEMPTS - 1 }).ok).toBe(false);
  });

  it("returns the number to pending at the limit — not blocked", () => {
    // Five wrong codes is a fat-fingered customer, not an attacker. The rate
    // limit already slowed them; blocking them would be a support ticket.
    const state = drive([["verify_sent"], ["verified"]]);
    const result = transition(state, "verify_exhausted", { now: T0, verifyAttempts: MAX_VERIFY_ATTEMPTS });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.status).toBe("pending");
      expect(result.next.verifiedAt).toBeNull();
    }
  });

  it("re-sending a code does not demote an already-verified number", () => {
    const state = drive([["verify_sent"], ["verified"], ["verify_sent"]]);
    expect(state.status).toBe("verified");
  });
});

describe("describeMarketingEligibility — the answer an operator actually wants", () => {
  it.each([
    [newSubscriber(), "Not verified"],
    [drive([["verify_sent"], ["verified"]]), "Verified — no marketing consent"],
    [drive([["verify_sent"], ["verified"], ["marketing_granted"]]), "Awaiting confirmation reply"],
    [ACTIVE(), "SMS MEMBER — ACTIVE"],
  ])("reports %#", (state, expected) => {
    expect(describeMarketingEligibility(state)).toBe(expected);
  });

  it("reports an opt-out and a block distinctly", () => {
    const out = transition(ACTIVE(), "marketing_revoked", { now: T0 });
    const blocked = transition(ACTIVE(), "blocked", { now: T0 });
    if (out.ok) expect(describeMarketingEligibility(out.next)).toBe("Opted out");
    if (blocked.ok) expect(describeMarketingEligibility(blocked.next)).toBe("Blocked");
  });

  it("never reports ACTIVE for anything canSendMarketing refuses", () => {
    const states = [
      newSubscriber(),
      drive([["verify_sent"], ["verified"]]),
      drive([["verify_sent"], ["verified"], ["marketing_granted"]]),
      { ...ACTIVE(), status: "opted_out" as const },
      { ...ACTIVE(), status: "blocked" as const },
    ];
    for (const state of states) {
      expect(canSendMarketing(state)).toBe(false);
      expect(describeMarketingEligibility(state)).not.toBe("SMS MEMBER — ACTIVE");
    }
  });
});
