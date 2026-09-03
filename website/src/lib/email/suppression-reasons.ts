// ---------------------------------------------------------------------------
// WHY AN ADDRESS IS SUPPRESSED, AND WHO IS ALLOWED TO UNDO IT.
//
// `email_suppressions` has one row per address and a free-text `reason`, and
// two very different kinds of thing were writing it:
//
//   * the CUSTOMER'S OWN CHOICE — unticking "Product news and promotions", or
//     following an unsubscribe link. Theirs to reverse whenever they like.
//   * the MAILBOX PROVIDER'S VERDICT — a spam complaint or a hard bounce,
//     written by the delivery webhook. Not a preference. Reversing one means
//     mailing somebody who pressed "report spam", or a mailbox that does not
//     exist.
//
// POST /api/account/preferences did not distinguish them. Ticking the
// promotions box ran an unconditional
//
//     .from("email_suppressions").delete().eq("email", email)
//
// so a complainer or a dead address was put back on every marketing list. And
// because a provider suppression never mirrored into `customer_preferences`,
// the box rendered ALREADY TICKED for exactly those people — so any save of
// that panel resurrected them, without the customer changing anything or
// intending to.
//
// That is not a small bookkeeping error. Continuing to mail addresses that
// reported the store as spam is the fastest way there is to wreck a sending
// domain's reputation — and a wrecked reputation is what got a DELIVERED
// confirmation email filed as spam, with its links stripped, on 2026-08-29.
// The receipts and password resets ride on that same domain.
// ---------------------------------------------------------------------------

/**
 * Suppressions the customer may lift themselves.
 *
 * "soft_bounce_run" is here rather than beside the provider verdicts, and the
 * distinction is the point. A hard bounce and a complaint are STATEMENTS by the
 * mailbox provider: the address does not exist, or its owner reported us. A run
 * of transient bounces is an INFERENCE we drew — usually right, and wrong in
 * exactly the case that costs most: a real, engaged customer whose mailbox was
 * full for a few days, or a receiving server having a bad week.
 *
 * A dead address that re-subscribes simply re-escalates on the next send. A
 * live customer who wants the mail gets it back the moment they ask. The
 * asymmetry runs the other way from the provider verdicts, so the reversibility
 * does too.
 */
export const CUSTOMER_CHOSEN_SUPPRESSION_REASONS = ["account_preference", "unsubscribed", "soft_bounce_run"] as const;

/** Suppressions a mailbox provider imposed. Never lifted by a preference save. */
export const PROVIDER_IMPOSED_SUPPRESSION_REASONS = ["complained", "bounced"] as const;

export type SuppressionReason =
  | (typeof CUSTOMER_CHOSEN_SUPPRESSION_REASONS)[number]
  | (typeof PROVIDER_IMPOSED_SUPPRESSION_REASONS)[number];

/**
 * Whether re-opting in may clear this suppression.
 *
 * An UNKNOWN reason is treated as provider-imposed — the safe direction. A
 * reason nobody recognises is not evidence the customer chose it, and the cost
 * of being wrong is asymmetric: keeping someone off a marketing list is a minor
 * annoyance they can raise with support, while mailing a complainer costs the
 * domain that also carries every receipt.
 */
export function isCustomerReversibleSuppression(reason: string | null | undefined): boolean {
  return (CUSTOMER_CHOSEN_SUPPRESSION_REASONS as readonly string[]).includes(String(reason ?? ""));
}
