// The single definition of the purchase acknowledgements.
//
// Both checkout lanes render this list and the server validates the same keys
// via `hasAllAcknowledgements`. It lives here because the two lanes used to
// keep private copies kept in step only by a comment claiming they were
// "byte-identical" — and they silently drifted: a statement was added to the
// express lane only while the server began requiring it, which made the card
// lane un-checkout-able. A shared constant makes that class of drift
// impossible rather than merely discouraged.
//
// ---------------------------------------------------------------------------
// PRODUCT DECISION, 2026-08-24. This file previously carried the instruction
// "never merge statements into one, never pre-tick a box". Both halves were
// deliberately overridden by the owner, in writing, after being shown what
// each one cost. Recorded here rather than deleted, because a future reader
// deserves the reasoning and not just the outcome:
//
//   MERGING. Checkout asked for four separate ticks, three of which were
//   research/compliance. They are now ONE statement. Nothing was dropped: the
//   assertions that carry the most weight for this product category — 21+,
//   legally permitted, laboratory research only, NOT for human or veterinary
//   use — remain visible in the sentence itself. The remainder (not drugs or
//   supplements, no dosing guidance, handling and storage responsibility) is
//   incorporated by reference from the Research Disclaimer, which genuinely
//   covers all of it. Four repetitive clicks were not buying four times the
//   protection.
//
//   PRE-TICKING. Both boxes now start CHECKED. The trade is real and was
//   accepted knowingly: a pre-ticked box evidences "did not object" rather
//   than "affirmatively agreed". Two things bound the cost. Nothing technical
//   depends on the initial value — both validators inspect only the SUBMITTED
//   values, so a shopper who unticks a box is refused by the server, not just
//   by the button. And the customer can still untick either one, which is the
//   difference between a default and a fiction.
//
// What must NOT change without the same deliberation: the wording is still
// legally load-bearing, the two statements stay separate from each other, and
// the server must keep requiring a real boolean `true` for both.
// ---------------------------------------------------------------------------

export interface RequiredConfirmation {
  key: "researchCompliance" | "returnsPolicy";
  short: string;
  title: string;
  body: string;
  policyHref?: string;
  /** Link text for `policyHref`. Names the document being incorporated. */
  policyLabel?: string;
}

export const REQUIRED_CONFIRMATIONS: readonly RequiredConfirmation[] = [
  {
    key: "researchCompliance",
    short: "Research & Compliance",
    title: "Research & Compliance *",
    body:
      "I confirm I am 21 or older and legally permitted, that these products are for laboratory research only and not for human or veterinary use, and that I have read and agree to the Research & Compliance Terms.",
    policyHref: "/legal/research-disclaimer",
    policyLabel: "Read the Research & Compliance Terms",
  },
  {
    key: "returnsPolicy",
    short: "Return & Reimbursement Policy",
    title: "Return & Reimbursement Policy *",
    body: "I have read and agree to the Return & Reimbursement Policy.",
    policyHref: "/legal/refund",
    policyLabel: "Read the Return & Reimbursement Policy",
  },
] as const;

export type AcknowledgementKey = RequiredConfirmation["key"];

/**
 * The state both lanes start from: every statement TICKED.
 *
 * Deliberate, and deliberately the only place it is decided, so the two lanes
 * cannot disagree about the default. Unticking is what the shopper is being
 * offered; the server still refuses anything that arrives false or missing.
 */
export function defaultAcknowledgements(): Record<AcknowledgementKey, boolean> {
  return Object.fromEntries(REQUIRED_CONFIRMATIONS.map((item) => [item.key, true])) as Record<
    AcknowledgementKey,
    boolean
  >;
}
