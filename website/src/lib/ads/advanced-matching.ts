import "server-only";

import { createHash } from "node:crypto";

/**
 * Advanced Matching — hashed identifiers for `ttq.identify()`.
 *
 * TikTok's snippet says to hash on the client. Hashing here instead is strictly
 * better and satisfies the same requirement: the digest is what TikTok needs,
 * and doing it server-side means the raw address is never handed to client
 * JavaScript, never sits in a React prop, and never appears in a page's
 * serialised payload. Only the digest crosses the boundary.
 *
 * Normalisation matters as much as the hash. TikTok matches digests, so
 * `Jo@Example.COM ` and `jo@example.com` must produce the same bytes or the
 * match silently fails and Advanced Matching quietly does nothing. Trim,
 * lowercase, then hash — the convention every platform shares.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Lowercased and trimmed. Returns null for anything that is not an address. */
export function normalizeEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

/**
 * E.164 without the leading plus, which is what TikTok expects. Punctuation and
 * spacing vary wildly in stored numbers and none of it is part of the identity.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export type AdvancedMatchingPayload = {
  email?: string;
  phone_number?: string;
  external_id?: string;
};

/**
 * Build the identify payload, omitting anything we do not genuinely have.
 *
 * An empty or placeholder value is worse than an absent one: it pollutes the
 * match set with a digest of the empty string, which every visitor lacking that
 * field would share.
 */
export function buildAdvancedMatching(input: {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
}): AdvancedMatchingPayload | null {
  const payload: AdvancedMatchingPayload = {};

  const email = normalizeEmail(input.email);
  if (email) payload.email = sha256(email);

  const phone = normalizePhone(input.phone);
  if (phone) payload.phone_number = sha256(phone);

  const externalId = String(input.externalId ?? "").trim();
  if (externalId) payload.external_id = sha256(externalId.toLowerCase());

  return Object.keys(payload).length > 0 ? payload : null;
}
