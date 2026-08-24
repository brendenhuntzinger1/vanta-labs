// The single definition of the purchase acknowledgements.
//
// Both checkout lanes render this list and the server validates the same four
// keys via `hasAllAcknowledgements`. It lives here because the two lanes used
// to keep private copies that were only kept in step by a comment promising
// they were "byte-identical" — and they silently drifted: a fourth statement
// was added to the express lane only, while the server began requiring all
// four, which made the card lane un-checkout-able. A shared constant makes
// that class of drift impossible rather than merely discouraged.
//
// This wording is legally load-bearing: reuse it verbatim, never reword it,
// never merge statements into one, never pre-tick a box. `short` is a
// display-only label for the compact row; the full `body` stays one tap away
// behind "View details".

export interface RequiredConfirmation {
  key: "researchResponsibility" | "researchCompliance" | "ageLegalConfirmation" | "returnsPolicy";
  short: string;
  title: string;
  body: string;
  policyHref?: string;
}

export const REQUIRED_CONFIRMATIONS: readonly RequiredConfirmation[] = [
  {
    key: "researchResponsibility",
    short: "Research responsibility",
    title: "Research Responsibility Statement *",
    body: "The purchaser assumes full responsibility for the proper handling, storage, and use of these laboratory materials. The seller provides products solely as research reference materials and does not provide medical or dosing guidance.",
  },
  {
    key: "researchCompliance",
    short: "Research & compliance agreement",
    title: "Research & Compliance Agreement *",
    body: "I acknowledge that the products sold on this website are intended strictly for laboratory research purposes. I confirm that I am purchasing these materials for legitimate research use and not for human or veterinary use. I understand these products are not drugs, dietary supplements, or medical products, and no instructions for preparation, dosage, or administration are provided by the seller.",
  },
  {
    key: "ageLegalConfirmation",
    short: "I am 21+ and legally permitted",
    title: "Age & Legal Confirmation *",
    body: "I confirm that I am 21 years of age or older and legally permitted to purchase laboratory research materials.",
  },
  {
    key: "returnsPolicy",
    short: "Returns & Refunds Policy",
    title: "Returns & Refunds Policy *",
    body: "I acknowledge and accept the Returns & Refunds Policy. Standard returns must be requested within 14 days of delivery, and products must remain unused and unopened with the original factory cap/seal intact. Contact support before sending anything back.",
    policyHref: "/legal/refund",
  },
] as const;

export type AcknowledgementKey = RequiredConfirmation["key"];

/** Every statement unticked. Affirmative consent is recorded, never assumed. */
export function emptyAcknowledgements(): Record<AcknowledgementKey, boolean> {
  return Object.fromEntries(REQUIRED_CONFIRMATIONS.map((item) => [item.key, false])) as Record<
    AcknowledgementKey,
    boolean
  >;
}
