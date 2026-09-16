// No `server-only`: the sign-up form, the checkout and the account settings
// page are Client Components and show this sentence beside the box, and the
// server stores the same sentence with the consent row. One definition, so
// what was shown and what was recorded can never drift apart.

/**
 * THE STORE'S TCPA CONSENT SENTENCE, as the carriers' A2P 10DLC review saw
 * it. The Omnisend pop-up carries the same words (scripts/omnisend/form.mjs
 * SMS_CONSENT). Never widened, never pre-ticked anywhere it appears.
 */
export const SMS_CONSENT_TEXT =
  "Yes, I would like to receive recurring automated marketing text messages from Vanta Labs at the number above. "
  + "Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. "
  + "Reply STOP to cancel at any time or HELP for help.";

/** The line under the box: what the texts are, and that the number stays ours. */
export const SMS_DISCLOSURE_TEXT =
  "Restock alerts, cart reminders and subscriber offers by text. Your number is never shared with third parties for their marketing.";

/**
 * A number a person could be texted at: digits with the punctuation people
 * type (+, spaces, dashes, dots, parentheses), 7 to 15 digits inside it
 * (ITU E.164's cap). The formatting is kept; the normaliser for the wire is
 * contact-payload.ts normalizeE164. Null for anything else, including empty.
 */
export function acceptableSmsPhone(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().slice(0, 40);
  if (!value) return null;
  if (!/^[+\d().\-\s]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return value;
}
