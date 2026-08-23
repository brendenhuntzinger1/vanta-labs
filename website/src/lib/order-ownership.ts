import "server-only";

/**
 * The PostgREST `.or()` filter that answers "is this order this customer's?".
 *
 * TWO BUGS LIVED IN THE HAND-ROLLED VERSIONS OF THIS, one in customer-account.ts
 * and an identical copy in account-orders.ts. Both built the clause as
 * `customer_email.ilike.<sanitised email>`, where the sanitiser was an
 * allow-list of `[a-zA-Z0-9@._-]`:
 *
 *  1. IT LET `_` THROUGH, AND `_` IS A SQL WILDCARD. PostgREST rewrites only
 *     `*` to `%`; `_` reaches ILIKE verbatim as "any single character". A
 *     signed-in customer whose own address contains an underscore — an ordinary
 *     thing — was therefore handed every order belonging to any address that
 *     differs from theirs by exactly one character in that position. That is a
 *     cross-customer authorization failure, not a cosmetic one: it exposes
 *     another person's order history, totals and shipping tracking.
 *
 *  2. IT STRIPPED `+`, WHICH IS A LEGAL AND COMMON EMAIL CHARACTER. A shopper
 *     using `name+shop@gmail.com` had it rewritten to `nameshop@gmail.com`,
 *     which matches nothing, so their own orders vanished from their account.
 *
 * The fix is to stop pattern-matching entirely. Ownership is an equality
 * question, so it uses `eq` with the value double-quoted — PostgREST's own
 * escape for a literal — and wildcards become inert characters rather than
 * operators. Emails are stored lowercased at order creation, so a lowercased
 * exact match is the correct comparison.
 */

/**
 * Escape a value for use inside a PostgREST `.or()` clause.
 *
 * PostgREST splits the clause on commas and parentheses, so a raw value could
 * otherwise inject an extra filter. Double quotes make it a literal; a quote or
 * backslash inside it is backslash-escaped.
 */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Emails longer than this are not real; the cap bounds the query string. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Normalise an email for comparison WITHOUT changing which address it is.
 *
 * Lowercasing and trimming are safe (order rows are written lowercased).
 * Removing characters is not — that is what broke plus-addressing — so an
 * address carrying anything outside the conservative shape below is treated as
 * unusable and the caller falls back to matching on account id alone. Refusing
 * to match is the safe direction: the customer sees fewer of their own orders,
 * never somebody else's.
 */
export function normalizeOwnershipEmail(email?: string | null): string | null {
  const trimmed = (email ?? "").trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_EMAIL_LENGTH) {
    return null;
  }
  // One @, no whitespace, no comma/paren/quote that could escape the clause.
  if (!/^[^\s@,()"\\]+@[^\s@,()"\\]+\.[^\s@,()"\\]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * THE EMAIL AN ACCOUNT MAY CLAIM ORDERS WITH — OR NULL.
 *
 * Matching a guest order by its email address is how someone who checked out
 * without an account still sees that order after signing up. It is also, on its
 * own, an authorization rule that says: WHOEVER TYPES THIS ADDRESS OWNS THESE
 * ORDERS. Guest orders carry the buyer's name, full shipping address, phone,
 * line items, totals and live tracking.
 *
 * That rule is only safe while the account has PROVEN it controls the mailbox.
 * The application was not checking: /api/auth/session establishes a session for
 * any token Supabase issues and reads email_confirmed_at solely to decide
 * whether to award signup points. So the entire guarantee rested on the
 * Supabase project's "confirm email" setting — a dashboard toggle, outside this
 * repository, that no test covers and that nothing here would notice being
 * turned off. Auto-confirm is the default for a new project, and with it on,
 * signing up as someone else's address hands over their order history.
 *
 * So the precondition is enforced here instead, where it is visible and
 * testable. An unconfirmed account still sees every order carrying its
 * customer_user_id — which is every order it has placed while signed in. What
 * it cannot do is reach BACKWARDS to orders it has only named.
 *
 * Returns null for an unconfirmed (or emailless) user, which callers pass
 * straight through as "match on account id alone".
 */
export function ownershipEmail(
  user: { email?: string | null; email_confirmed_at?: string | null } | null | undefined,
): string | null {
  if (!user?.email_confirmed_at) return null;
  return user.email ?? null;
}

/**
 * Build the ownership filter for an orders query.
 *
 * Matches on the account id first — it survives an email change and works for
 * accounts with no email — OR on the exact email, which is how orders placed
 * before customer_user_id was recorded are still found. Callers must source
 * that email from `ownershipEmail()`, never from the session user directly.
 */
export function buildOrderOwnershipFilter(userId: string, email?: string | null): string {
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9-]/g, "");
  const normalizedEmail = normalizeOwnershipEmail(email);
  return normalizedEmail
    ? `customer_user_id.eq.${safeUserId},customer_email.eq.${quoteFilterValue(normalizedEmail)}`
    : `customer_user_id.eq.${safeUserId}`;
}
