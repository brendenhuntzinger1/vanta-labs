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
/**
 * THE VERSION OF THE WORDING ABOVE, stored with every consent row
 * (sms_subscribers.disclosure_version). A carrier dispute asks what the person
 * was shown, not what the site says today, so the row records which text it
 * was. BUMP THIS whenever SMS_CONSENT_TEXT changes, by one line, and never
 * edit the sentence without bumping it.
 */
export const SMS_DISCLOSURE_VERSION = "2026-09-16";

export const SMS_DISCLOSURE_TEXT =
  "Restock alerts, cart reminders and subscriber offers by text. Your number is never shared with third parties for their marketing.";

/**
 * THE NUMBERING PLAN'S OWN RULES, WHICH ARE NOT A GUESS ABOUT WHO OWNS A
 * NUMBER — they are what NANPA can and cannot assign, and they have never
 * changed.
 *
 *   * An area code's first digit is 2-9. Nothing beginning 0 or 1 is one.
 *   * Neither an area code nor an exchange may be N11 (411, 911 and the rest
 *     are service codes).
 *   * 555 has never been assigned as an area code.
 *   * An exchange's first digit is 2-9.
 *
 * So `1234567890`, `0000000000` and `5555555555` are not numbers somebody
 * mistyped — they are numbers that cannot exist. Rejecting them costs no real
 * customer anything.
 *
 * 555-01XX IS DELIBERATELY STILL ACCEPTED, and it is the one rule here that
 * was written and then taken out again. It is the range reserved for fiction,
 * so blocking it looks like the obvious catch — but it is also the range this
 * repository's own fixtures use, precisely so a test can never dial a real
 * person. Nine suites went red on it, all of them consent-path. Weighed
 * honestly the block buys very little: somebody set on faking a number types
 * their friend's or any assignable ten digits, and the structural rules above
 * already take the lazy cases. Trading a convention that keeps real numbers
 * out of the test suite for a speed bump one keystroke wide is a bad trade.
 */
function isImpossibleNanp(digits: string): boolean {
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return false;

  const npa = national.slice(0, 3);
  const nxx = national.slice(3, 6);

  if (npa[0] === "0" || npa[0] === "1") return true;
  if (npa[1] === "1" && npa[2] === "1") return true;
  if (npa === "555") return true;
  if (nxx[0] === "0" || nxx[0] === "1") return true;
  if (nxx[1] === "1" && nxx[2] === "1") return true;
  return false;
}

/**
 * A number a person could be texted at: digits with the punctuation people
 * type (+, spaces, dashes, dots, parentheses), 7 to 15 digits inside it
 * (ITU E.164's cap). The formatting is kept; the normaliser for the wire is
 * contact-payload.ts normalizeE164. Null for anything else, including empty.
 *
 * THIS PROVES NOTHING ABOUT OWNERSHIP, and must not be read as though it did.
 * It rejects what cannot be a number; it cannot tell a real stranger's number
 * from the subscriber's own. Only a confirmation the handset answers can do
 * that, and this store does not send one yet — which is why recordSmsConsent
 * leaves `status` at the table's default rather than writing "verified".
 *
 * IT MATTERS MOST FOR THE NUMBERS THAT ARE REAL AND NOT THEIRS. An
 * undeliverable number costs a message; a stranger's costs a complaint, and
 * complaint rate is what gets a 10DLC campaign shut off. Everything below only
 * removes the impossible, which is the cheap half of that problem.
 *
 * Applied to NANP numbers only. A `+` followed by another country's code is
 * left to its own plan's rules, which this does not encode.
 */
export function acceptableSmsPhone(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().slice(0, 40);
  if (!value) return null;
  if (!/^[+\d().\-\s]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // One digit repeated is nobody's number, in any plan.
  if (/^(\d)\1+$/.test(digits)) return null;
  // A bare 10 or 11 digits is read as North American, exactly as normalizeE164
  // reads it; a `+` on anything but +1 is another plan's business.
  const nanp = !value.startsWith("+") || digits.startsWith("1");
  if (nanp && isImpossibleNanp(digits)) return null;
  return value;
}
