// ---------------------------------------------------------------------------
// IS THIS SHAPED LIKE AN EMAIL ADDRESS AT ALL?
//
// Four auth routes each carried the same check:
//
//     if (!email || !email.includes("@") || email.length > 320) { ... }
//
// which accepts "a@", "@", "a@b" and "@." — none of which can receive mail. The
// route then answers its deliberately generic "check your email", so the
// customer is told to go and look in a mailbox that does not exist.
//
// It also costs something now that a mint failure is treated as serious. The
// signup route raises `signup_mint_failed` at severity CRITICAL when the link
// cannot be minted for an address with no account — which is exactly what
// GoTrue does with "a@". Left as it was, an ordinary typo pages the operator,
// and an alert that fires on typos is an alert people learn to ignore. The
// real failures it exists for would be buried under them.
//
// So the shape is checked before anything is spent on it: no mint attempt, no
// alert, and the caller can tell a typo apart from a genuine failure.
//
// DELIBERATELY CONSERVATIVE, NOT RFC-COMPLETE. Full RFC 5322 permits quoted
// local parts and bracketed literals that no storefront customer will ever
// type, and a regex that tries to allow them is a regex nobody can review. The
// only job here is to reject what obviously cannot receive mail; anything that
// passes is still validated properly by GoTrue.
//
// The pattern matches lib/order-ownership.ts, which had to solve the same
// problem for a different reason.
// ---------------------------------------------------------------------------

/** Longer than this is not a real address; the cap also bounds any query. */
export const MAX_EMAIL_LENGTH = 320;

/**
 * One `@`, something either side, and a dot-separated domain. No whitespace,
 * and none of the characters that would let a value escape a PostgREST filter.
 */
const EMAIL_SHAPE = /^[^\s@,()"\\]+@[^\s@,()"\\.]+(\.[^\s@,()"\\.]+)+$/;

/**
 * Whether an address is worth spending a mint, a send or an alert on.
 *
 * Returns false for the empty string, so callers do not need a separate check.
 */
export function looksLikeEmail(value: unknown): boolean {
  const email = String(value ?? "").trim();
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_SHAPE.test(email);
}
