/**
 * The visitor's cookie choice, readable on the SERVER.
 *
 * WHY THIS EXISTS
 *
 * The consent banner records the choice in `localStorage`. That is fine for the
 * pixels, which are client-side and read it directly — but it makes the choice
 * invisible to every route handler, and at least one route was writing
 * consent-gated data because of it.
 *
 * `/r/[code]` (the public affiliate link) recorded `utm_source`, `utm_medium`,
 * `utm_campaign`, the referrer, the user agent and the raw IP address of every
 * click, before and regardless of any choice. The published Cookie Policy
 * itemises "any campaign parameters from the link you arrived through" under
 * **"Analytics — only if you accept"**, and states that "choosing Decline on
 * the banner stops all non-essential storage". A server route that cannot see
 * the choice cannot honour either sentence.
 *
 * So the banner now mirrors the same value into a cookie, and this reads it.
 * The cookie carries no identifier — it is the literal string "accepted" or
 * "declined" — and recording a visitor's own privacy preference is itself
 * essential storage under any reading of the policy.
 *
 * DEFAULT IS "unset", AND "unset" IS NOT CONSENT. A visitor who has not
 * answered the banner yet, or who blocks cookies entirely, must be treated
 * exactly like one who declined. Anything else makes the default silently
 * permissive, which is the shape of the defect this closes.
 */

export const CONSENT_COOKIE_NAME = "vl_cookie_consent";

export type CookieConsent = "accepted" | "declined" | "unset";

/**
 * Parse the consent choice out of a request's Cookie header.
 *
 * Deliberately hand-parsed rather than taken from `next/headers`: this is
 * called from a route handler that already has the `Request`, and keeping it a
 * pure function of a string makes it directly testable without a Next runtime.
 */
export function readCookieConsent(request: Request): CookieConsent {
  const header = request.headers.get("cookie");
  if (!header) return "unset";

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== CONSENT_COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (value === "accepted" || value === "declined") return value;
    // A value we do not recognise is not a choice. Treat it as unanswered
    // rather than guessing, which keeps a corrupted cookie on the safe side.
    return "unset";
  }

  return "unset";
}

/** True only for an explicit "accepted". `unset` and `declined` both mean no. */
export function hasAnalyticsConsent(request: Request): boolean {
  return readCookieConsent(request) === "accepted";
}
