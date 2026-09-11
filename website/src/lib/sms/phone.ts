// E.164 normalisation. Pure, client-safe, and the ONLY place a phone number
// becomes canonical.
//
// WHY ONE PLACE. `sms_subscribers.phone_e164` is a primary key, and a primary
// key whose format is decided at three call sites is a primary key that will
// eventually hold the same person twice — once as +18135551234 and once as
// 8135551234 — which is how one number ends up carrying two consent states and
// one of them says STOP. Every write and every lookup goes through here.
//
// NO LIBRARY. This store ships to the United States and Canada (shipping.ts),
// which is one country code and one number length. libphonenumber is 500KB to
// answer a question with two cases.
//
// DELIBERATELY STRICT. A number this cannot parse is REFUSED rather than
// guessed at. Guessing produces a plausible-looking number belonging to someone
// who never asked to hear from us, and the cost of that mistake is measured per
// message in TCPA statutory damages.

/** The canonical form: `+1` followed by ten digits. */
export type E164 = string;

export type PhoneNormalisation =
  | { ok: true; e164: E164; digits: string }
  | { ok: false; reason: PhoneRejection; digits: string };

export type PhoneRejection =
  /** Nothing usable in the input at all. */
  | "empty"
  /** Fewer digits than any North American number has. */
  | "too_short"
  /** More digits than a NANP number, or an 11-digit string not starting with 1.
   *  Three such numbers exist in this store's own contact data today; they are
   *  suppressed under their raw digits rather than coerced into a US number. */
  | "not_nanp"
  /** Right length, but not a dialable NANP number — see the structural rules
   *  below. These are the shapes that look fine and are not real. */
  | "invalid_nanp";

/** Strip everything that is not a digit. Also the suppression key for a number
 *  that cannot be normalised — see `sms_suppressions.phone_raw`. */
export function phoneDigits(input: string | null | undefined): string {
  return String(input ?? "").replace(/\D/g, "");
}

/**
 * NANP structural rules, and each one exists because the shape it rejects is
 * not a number anyone can be reached on:
 *
 *   - area code (NPA) must start 2-9. No area code begins 0 or 1.
 *   - exchange (NXX) must start 2-9. Same reason.
 *   - exchange must not be N11 (211, 311, ... 911): those are service codes.
 *   - area code must not end "11" for the same reason.
 *   - 555-00xx and 555-01xx are refused. 555-0100 through 555-0199 is the
 *     range NANP reserves for fiction; 555-00xx is not assignable as a
 *     subscriber line either, and it is what `PHONE_LOGIN_ENABLED`'s own
 *     placeholder uses (+1 813 555 0000). A placeholder that parses as a real
 *     number is a placeholder that eventually gets texted. Note this is
 *     narrower than "refuse 555": 555 numbers outside these two blocks are
 *     ordinary assignable numbers and are accepted.
 */
function isDialableNanp(ten: string): boolean {
  const npa = ten.slice(0, 3);
  const nxx = ten.slice(3, 6);
  const line = ten.slice(6);

  if (npa[0] === "0" || npa[0] === "1") return false;
  if (nxx[0] === "0" || nxx[0] === "1") return false;
  if (npa[1] === "1" && npa[2] === "1") return false;
  if (nxx[1] === "1" && nxx[2] === "1") return false;
  if (nxx === "555" && (line.startsWith("00") || line.startsWith("01"))) return false;

  return true;
}

/**
 * Normalise to E.164, or say precisely why not.
 *
 * Accepts the shapes a human actually types — `(813) 555-1234`,
 * `813.555.1234`, `+1 813 555 1234`, `1-813-555-1234` — and nothing else.
 */
export function normalisePhone(input: string | null | undefined): PhoneNormalisation {
  const digits = phoneDigits(input);

  if (digits.length === 0) return { ok: false, reason: "empty", digits };
  if (digits.length < 10) return { ok: false, reason: "too_short", digits };

  let ten: string;
  if (digits.length === 10) {
    ten = digits;
  } else if (digits.length === 11 && digits[0] === "1") {
    ten = digits.slice(1);
  } else {
    // 11 digits not starting with 1, or 12+. Could be international, could be a
    // typo. Both are "not something we can dial", and the difference does not
    // change what we do about it.
    return { ok: false, reason: "not_nanp", digits };
  }

  if (!isDialableNanp(ten)) return { ok: false, reason: "invalid_nanp", digits };

  return { ok: true, e164: `+1${ten}`, digits };
}

/** True when `value` is already exactly canonical. Used to assert that stored
 *  keys never drifted, rather than to validate user input. */
export function isE164(value: string | null | undefined): value is E164 {
  return typeof value === "string" && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(value)
    && isDialableNanp(value.slice(2));
}

/**
 * For display and for logs: `+1 813 ••• 4417`.
 *
 * A phone number is PII and the admin surfaces show it to staff who only need
 * to recognise it, not dial it. Anything written to a log or an alert uses this
 * — the same posture `redactEmailForLog` takes for addresses.
 */
export function maskPhone(value: string | null | undefined): string {
  const digits = phoneDigits(value);
  if (digits.length < 4) return "•••";
  const ten = digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
  if (ten.length !== 10) return `•••${digits.slice(-4)}`;
  return `+1 ${ten.slice(0, 3)} ••• ${ten.slice(6)}`;
}

/**
 * Line types Twilio Lookup reports that we refuse at signup.
 *
 * VOIP is the cheap end of verification abuse: a disposable number costs
 * nothing, which is the whole economics of SMS pumping fraud and of farming a
 * gift with a fresh number. Landlines cannot receive SMS at all, so accepting
 * one produces a subscriber who can never be reached and never opt out.
 */
export const REFUSED_LINE_TYPES = ["voip", "landline", "nonFixedVoip", "fixedVoip"] as const;

export function isRefusedLineType(lineType: string | null | undefined): boolean {
  if (!lineType) return false;
  const normalised = String(lineType).trim();
  return REFUSED_LINE_TYPES.some((refused) => refused.toLowerCase() === normalised.toLowerCase());
}
