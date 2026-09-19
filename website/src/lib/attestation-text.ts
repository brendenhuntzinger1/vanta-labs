/**
 * The two statements a visitor makes about themselves, in one place.
 *
 * WHY THIS FILE EXISTS. attestation-form.tsx already carried the warning —
 * "copied from account-auth-form.tsx and must move with it" — and a warning is
 * not a mechanism. These are representations a person makes, and two screens
 * that ask for them in different words are two different representations in the
 * record. A third screen was about to be added, so the strings move here and
 * every surface reads them rather than retyping them.
 *
 * Neither sentence is ever pre-ticked and neither is ever inferred: a prior
 * order, a shipping address or a subscription is why we are writing to
 * somebody, not a statement about their age.
 */

/** Age. The only number in the store that is a legal threshold. */
export const AGE_ATTESTATION_TEXT = "I confirm that I am at least 21 years old.";

/** What the products are for, and what they are not for. */
export const RESEARCH_USE_ATTESTATION_TEXT =
  "I agree and understand that the products on this site are intended strictly for laboratory research use only, and not for human or animal consumption.";

/**
 * Where the browser remembers that this visitor has already answered.
 *
 * A UI gate, deliberately, and not an access control: the wall, the SQL
 * policies and the checkout's own attestation are what actually withhold
 * anything. This only stops the front door showing a research-peptide
 * catalogue's marketing to somebody who has not said they are 21.
 */
export const AGE_GATE_STORAGE_KEY = "vl_age_attested";
