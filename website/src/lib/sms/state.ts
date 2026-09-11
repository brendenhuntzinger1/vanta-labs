// The subscriber state machine. Pure, so every legal and illegal transition is
// testable without a database.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE:
//
//     A VERIFIED NUMBER IS NOT A MARKETING SUBSCRIBER.
//
// Verification proves that the person holding the phone typed a code we sent.
// It proves possession. It does not prove they agreed to receive marketing, and
// conflating the two is the single most likely way this programme generates
// TCPA liability — the store already holds ~33 numbers collected for shipping
// and contact, every one of which is "a real number belonging to a real
// customer" and none of which carries marketing consent.
//
// So marketing eligibility is THREE independent conditions checked together in
// ONE function (`canSendMarketing`). It is deliberately not derivable from any
// single column, and deliberately not re-derived at a call site.

export type SmsStatus = "pending" | "verified" | "opted_out" | "blocked";

/** The subscriber fields the machine reasons about. A row, narrowed. */
export type SubscriberState = {
  status: SmsStatus;
  marketingConsent: boolean;
  /** Null until the subscriber replies to the confirmation message. */
  doubleOptinConfirmedAt: string | null;
  verifiedAt: string | null;
  optedOutAt: string | null;
  resubscribedAt: string | null;
  resubscribeCount: number;
};

export type SmsEvent =
  /** A code was sent to the number. */
  | "verify_sent"
  /** The code came back correct. Proves possession. Grants nothing. */
  | "verified"
  /** Verification failed too many times, or the code expired. */
  | "verify_exhausted"
  /** The customer ticked the marketing box, having seen the disclosure. */
  | "marketing_granted"
  /** The customer replied YES (or equivalent) to the confirmation message. */
  | "double_optin_confirmed"
  /** STOP, an admin, or a hard carrier failure. */
  | "marketing_revoked"
  /** START, after the cooldown. */
  | "resubscribed"
  /** Abuse. Terminal, admin only. */
  | "blocked";

export type TransitionResult =
  | { ok: true; next: SubscriberState; reason?: string }
  | { ok: false; reason: string };

/**
 * How long after opting out before START can restore eligibility.
 *
 * NOT anti-customer friction — it is anti-farming. The introductory gift is
 * once-ever per identity, but `resubscribe_count` is what makes a
 * STOP/START/STOP/START pattern visible, and a cooldown makes it pointless. A
 * customer who genuinely wants back in waits a month or asks support; a script
 * cycling for entitlements gets nothing either way.
 */
export const RESUBSCRIBE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum failed code entries before the number returns to `pending`. */
export const MAX_VERIFY_ATTEMPTS = 5;

/**
 * MAY WE SEND MARKETING TO THIS SUBSCRIBER?
 *
 * Three conditions, together, in one place:
 *
 *   1. status === "verified"        — possession proven, not opted out, not blocked
 *   2. marketingConsent === true    — they said yes to marketing specifically
 *   3. doubleOptinConfirmedAt       — they confirmed it FROM the device
 *
 * Condition 3 is carrier-required for abandoned-cart messaging and is also what
 * earns "Known Sender" status on a new number, so it is not optional even where
 * the law alone might not demand it.
 *
 * SUPPRESSION IS NOT CHECKED HERE, on purpose. Suppression is a separate,
 * fail-closed database read immediately before dispatch (sms/suppression.ts):
 * a pure function cannot fail closed on a read it does not perform, and a
 * predicate that LOOKED complete would invite callers to skip the read.
 */
export function canSendMarketing(state: SubscriberState): boolean {
  return state.status === "verified"
    && state.marketingConsent === true
    // BOOLEAN, NOT `!== null`. A row read back from a column that was never
    // written yields `undefined` rather than `null`, and `undefined !== null`
    // is true — so the strict form let a subscriber who had not confirmed
    // anything pass the third condition. Caught by consent.test.ts before it
    // could send anything. `Boolean` also rejects the empty string, so no
    // spelling of "absent" gets through.
    && Boolean(state.doubleOptinConfirmedAt);
}

/**
 * May we send a transactional message — an order confirmation, a shipping
 * notice, a verification code?
 *
 * Deliberately weaker: possession is enough, because these are not
 * solicitations and the customer asked for the underlying thing by ordering.
 * `opted_out` still receives them, which is the correct and slightly
 * counter-intuitive answer — a STOP to the marketing number must not cost
 * someone their shipping notifications, which is exactly why the programme
 * uses two numbers.
 *
 * `blocked` receives nothing at all.
 */
export function canSendTransactional(state: SubscriberState): boolean {
  return state.status === "verified" || state.status === "opted_out";
}

/** A fresh row for a number we have only just been given. */
export function newSubscriber(): SubscriberState {
  return {
    status: "pending",
    marketingConsent: false,
    doubleOptinConfirmedAt: null,
    verifiedAt: null,
    optedOutAt: null,
    resubscribedAt: null,
    resubscribeCount: 0,
  };
}

/**
 * Apply an event, or refuse it with a reason.
 *
 * REFUSALS CARRY A REASON rather than returning a bare false, because the
 * reasons end up in the admin and in `sms_consent_events.detail`. "Why is this
 * person not getting messages" is the question an operator actually asks, and
 * the answer should not require reading this file.
 */
export function transition(
  state: SubscriberState,
  event: SmsEvent,
  options: { now?: number; verifyAttempts?: number } = {},
): TransitionResult {
  const now = options.now ?? 0;
  const at = new Date(now).toISOString();

  // BLOCKED IS TERMINAL AND ABSORBS EVERYTHING. Checked first so no event below
  // has to remember to exclude it.
  if (state.status === "blocked" && event !== "blocked") {
    return { ok: false, reason: "This number is blocked." };
  }

  switch (event) {
    case "blocked":
      return {
        ok: true,
        next: {
          ...state,
          status: "blocked",
          // Blocking revokes marketing too. Leaving consent true on a blocked
          // row would make `canSendMarketing` depend on the status check alone.
          marketingConsent: false,
          doubleOptinConfirmedAt: null,
        },
      };

    case "verify_sent":
      // Re-sending a code to an already-verified number is allowed (a
      // re-verification, e.g. after a long gap) and does not demote it.
      return { ok: true, next: state };

    case "verified":
      if (state.status === "opted_out") {
        // Verifying again does NOT undo an opt-out. Coming back requires an
        // explicit resubscribe, which is a fresh consent rather than a side
        // effect of proving possession a second time.
        return { ok: false, reason: "This number opted out; it must resubscribe explicitly." };
      }
      return {
        ok: true,
        next: {
          ...state,
          status: "verified",
          verifiedAt: state.verifiedAt ?? at,
          // EXPLICIT, AND THE WHOLE POINT OF THIS FILE: verification grants no
          // marketing permission. Whatever consent existed is carried, not
          // created.
          marketingConsent: state.marketingConsent,
        },
      };

    case "verify_exhausted":
      if ((options.verifyAttempts ?? 0) < MAX_VERIFY_ATTEMPTS) {
        return { ok: false, reason: "Attempts remain." };
      }
      // Back to pending, not blocked. A customer fat-fingering a code five
      // times is not an attacker, and the rate limit already slowed them down.
      return {
        ok: true,
        next: { ...state, status: "pending", verifiedAt: null },
        reason: "Verification attempts exhausted; the number returned to pending.",
      };

    case "marketing_granted":
      if (state.status !== "verified") {
        // The box can be ticked before the code is entered — the UI allows it
        // — but the grant does not take effect until possession is proven.
        return { ok: false, reason: "The number must be verified before marketing consent takes effect." };
      }
      return {
        ok: true,
        next: {
          ...state,
          marketingConsent: true,
          // NOT YET SENDABLE. `canSendMarketing` still requires the double
          // opt-in confirmation below.
          doubleOptinConfirmedAt: state.doubleOptinConfirmedAt,
        },
      };

    case "double_optin_confirmed":
      if (state.status !== "verified") {
        return { ok: false, reason: "The number must be verified first." };
      }
      if (!state.marketingConsent) {
        // A reply to a confirmation message is not itself the consent — the
        // disclosure and the tick are. Confirming without a grant on file
        // would manufacture consent from a text message.
        return { ok: false, reason: "No marketing consent on file to confirm." };
      }
      return { ok: true, next: { ...state, doubleOptinConfirmedAt: state.doubleOptinConfirmedAt ?? at } };

    case "marketing_revoked":
      // ALWAYS ALLOWED, from any state, idempotently. An opt-out must never be
      // refused for being redundant, out of order, or from an unexpected
      // state — the one path that may never fail closed.
      return {
        ok: true,
        next: {
          ...state,
          status: "opted_out",
          marketingConsent: false,
          doubleOptinConfirmedAt: null,
          optedOutAt: state.optedOutAt ?? at,
        },
      };

    case "resubscribed": {
      if (state.status !== "opted_out") {
        return { ok: false, reason: "Only an opted-out number can resubscribe." };
      }
      const since = state.optedOutAt ? now - Date.parse(state.optedOutAt) : Infinity;
      if (Number.isFinite(since) && since < RESUBSCRIBE_COOLDOWN_MS) {
        const days = Math.ceil((RESUBSCRIBE_COOLDOWN_MS - since) / (24 * 60 * 60 * 1000));
        return { ok: false, reason: `Resubscribe cooldown: ${days} day(s) remaining.` };
      }
      return {
        ok: true,
        next: {
          ...state,
          status: "verified",
          resubscribedAt: at,
          resubscribeCount: state.resubscribeCount + 1,
          // BACK TO VERIFIED, NOT BACK TO SUBSCRIBED. Returning requires a
          // fresh disclosure, a fresh grant and a fresh confirmation, exactly
          // like a new subscriber — the previous consent was withdrawn and
          // does not revive.
          marketingConsent: false,
          doubleOptinConfirmedAt: null,
          optedOutAt: null,
        },
      };
    }
  }
}

/**
 * A one-line, operator-facing account of why someone is or is not receiving
 * marketing. Shown in the admin beside the subscriber.
 */
export function describeMarketingEligibility(state: SubscriberState): string {
  if (state.status === "blocked") return "Blocked";
  if (state.status === "pending") return "Not verified";
  if (state.status === "opted_out") return "Opted out";
  if (!state.marketingConsent) return "Verified — no marketing consent";
  if (!state.doubleOptinConfirmedAt) return "Awaiting confirmation reply";
  return "SMS MEMBER — ACTIVE";
}
