import "server-only";

import { createHash } from "node:crypto";

/**
 * Advanced Matching for the Reddit pixel — hashed identifiers for `rdt('init')`.
 *
 * WHY THIS IS NOT lib/ads/advanced-matching.ts. Reddit canonicalises an address
 * differently from TikTok and Snap, and the difference is silent: a digest that
 * does not match simply never matches, so the feature appears installed and
 * does nothing. Reddit's rule is lowercase, THEN strip every dot from the local
 * part, THEN drop anything from a `+` onwards. `jo.smith+shop@gmail.com` must
 * hash as `josmith@gmail.com`. Reusing the shared normaliser — trim and
 * lowercase only — would produce a different digest for any address containing
 * a dot or a plus tag, which is most of them.
 *
 * WHY IT HASHES ON THE SERVER. Reddit's pixel will accept a plaintext address
 * and hash it in the browser. That is the documented happy path and it is the
 * one this codebase refuses, for the same reason it refuses TikTok's and Snap's
 * equivalents: a raw address handed to client JavaScript is in the page's
 * serialised payload, in memory alongside every other script on the page, and
 * one XSS away from being read. Only the digest crosses the boundary. Reddit
 * cannot tell the difference — it hashes to the same 64 hex digits either way.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Reddit's canonical form of an email address, per its Advanced Matching spec:
 * lowercase, no dots in the local part, nothing after a `+`.
 *
 * Returns null for anything that is not an address. Reddit silently ignores
 * malformed input, so a bad value would not error — it would just quietly
 * lower the match rate, which is the failure mode worth refusing outright.
 */
export function canonicalizeRedditEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  const atIndex = value.lastIndexOf("@");
  const domain = value.slice(atIndex + 1);
  let local = value.slice(0, atIndex);

  const plusIndex = local.indexOf("+");
  if (plusIndex !== -1) local = local.slice(0, plusIndex);
  local = local.replace(/\./g, "");

  if (!local) return null;
  return `${local}@${domain}`;
}

/** The 64-lowercase-hex digest Reddit expects, or null when there is no address. */
export function hashRedditEmail(email: string | null | undefined): string | null {
  const canonical = canonicalizeRedditEmail(email);
  return canonical ? sha256(canonical) : null;
}

/**
 * An advertiser-assigned id for the same person, hashed.
 *
 * The account UUID. It is already pseudonymous — it means nothing outside this
 * database — and it survives an email change, which the email digest does not.
 */
export function hashRedditExternalId(externalId: string | null | undefined): string | null {
  const value = String(externalId ?? "").trim().toLowerCase();
  return value ? sha256(value) : null;
}

export type RedditMatchKeys = {
  email?: string;
  externalId?: string;
};

/**
 * Build the init payload, omitting anything we do not genuinely have.
 *
 * An empty or placeholder value is worse than an absent one: it pollutes the
 * match set with a digest every visitor lacking that field would share. Returns
 * null rather than `{}` so the caller can tell "no keys" from "some keys".
 */
export function buildRedditMatchKeys(input: {
  email?: string | null;
  externalId?: string | null;
}): RedditMatchKeys | null {
  const payload: RedditMatchKeys = {};

  const email = hashRedditEmail(input.email);
  if (email) payload.email = email;

  const externalId = hashRedditExternalId(input.externalId);
  if (externalId) payload.externalId = externalId;

  return Object.keys(payload).length > 0 ? payload : null;
}
