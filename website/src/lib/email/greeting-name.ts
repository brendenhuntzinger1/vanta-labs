/**
 * A customer-typed name, reduced to something safe to put in a greeting.
 *
 * Two public forms accept a free-text name and then mail it back out under the
 * store's own sending identity: the contact form (its auto-reply greets the
 * poster) and guest cart tracking (the recovery series greets the shopper). A
 * "name" is therefore text an anonymous caller can have delivered, branded, to
 * any address they type — "URGENT: call +1 555 0100" fits in 120 characters.
 *
 * So a greeting name is held to the shape of a name:
 *
 *   * anything carrying a digit, an address or a URL is not a name at all and
 *     yields nothing — a real customer's greeting never needs those, and a
 *     message needs them to be actionable;
 *   * what remains is letters (any script), marks, apostrophes and hyphens,
 *     in at most three words, at most forty characters.
 *
 * An empty result is a valid answer — every template already copes with no
 * name ("Hi there", or no greeting line at all). Pure, so it can be pinned by
 * a unit test with no database in the way.
 */
export const MAX_GREETING_NAME_LENGTH = 40;
export const MAX_GREETING_NAME_WORDS = 3;

/** Digits, an @, a scheme, or a www. — none of which belong in a name. */
const NOT_A_NAME = /[0-9@]|:\/\/|www\./i;

export function plainGreetingName(raw: unknown, maxLength: number = MAX_GREETING_NAME_LENGTH): string {
  const value = String(raw ?? "").normalize("NFKC").trim();
  if (!value || NOT_A_NAME.test(value)) return "";
  const words = value
    .replace(/[^\p{L}\p{M}\s'’\-]/gu, " ")
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, MAX_GREETING_NAME_WORDS);
  return words.join(" ").slice(0, maxLength).trim();
}
