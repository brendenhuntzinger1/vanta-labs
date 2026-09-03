// No `server-only`: this is a pure predicate over a string, and both the
// audience resolvers and their tests import it directly.

/**
 * Addresses that cannot belong to a real customer, and must never enter a
 * marketing audience.
 *
 * WHY THIS EXISTS. This account has genuinely sent to provider sink addresses —
 * the 2026-09-02 audit found delivered@, bounced@ and complained@resend.dev in
 * Resend's own log, left over from testing the delivery webhook. Two of them are
 * now suppressed because they did exactly what they are built to do.
 *
 * Nothing stopped one entering an audience in the first place. `marketing_
 * subscribers` is written by the checkout opt-in, so testing checkout with a
 * sink address puts it on the list and the next campaign mails it. A send to
 * bounced@resend.dev is a bounce recorded against this domain; a send to
 * complained@resend.dev is a SPAM COMPLAINT recorded against it. Every time.
 *
 * THE LIST IS DELIBERATELY NARROW. Only addresses that cannot be routed at all:
 * the domains RFC 2606 reserves so they can never resolve, and the provider's
 * own sink. Dropping a real subscriber is the worse mistake of the two, so
 * anything merely unusual is left alone — this is not a spam-address heuristic.
 */

/**
 * WHAT IS NOT HERE, AND WHY — this list got narrower twice while being written.
 *
 * RFC 2606 reserves example.com/.net/.org and the .test/.invalid/.localhost
 * TLDs so they can never route, which makes filtering them look obviously
 * right. Both attempts broke real tests: example.com is the idiomatic fixture
 * address across this repo's audience suites (31 failures), and .test is the
 * convention in audience-truncation (4 more). Every one of those tests was
 * asserting correct behaviour. A filter that only passes once you have rewritten
 * the fixtures around it has stopped describing production.
 *
 * The costs are not symmetric either, which settles it. An unroutable address on
 * a list is INERT: it bounces once, and the consecutive-soft-bounce escalation
 * added alongside this retires it without anyone doing anything. A provider sink
 * is not inert — it manufactures a bounce or a spam complaint against this
 * domain on purpose, every single time it is mailed.
 *
 * So the rule covers what actively causes harm and was actually found in
 * production, and nothing that merely looks like test data.
 */

/**
 * Provider sink domains. Mail here is accepted and then deliberately turned into
 * a bounce or a complaint, so it damages the sending domain by design.
 *
 * The audit of 2026-09-02 found all three of Resend's simulator addresses
 * already sent from this account while the delivery webhook was being tested.
 */
const SINK_DOMAINS = new Set(["resend.dev"]);

export function isNonMailableAddress(value: string | null | undefined): boolean {
  const email = String(value ?? "").trim().toLowerCase();
  // No address, or nothing that parses as one, is not something to mail. Said
  // here rather than left to the caller so every caller gets the same answer.
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return true;

  // Exact domain match, so "notresend.dev.co" and "myresend.dev" are untouched.
  return SINK_DOMAINS.has(email.slice(at + 1));
}
