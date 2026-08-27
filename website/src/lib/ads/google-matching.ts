import { createHash } from "node:crypto";

/**
 * Google's identity normalisation, kept deliberately apart from
 * advanced-matching.ts.
 *
 * It would be tempting to add Google's rules to the existing normaliser and
 * have one function for all four channels. That would be a silent regression.
 * TikTok and Snap have been sending SHA-256 digests of addresses normalised
 * the existing way for the whole life of those integrations; strip dots from
 * Gmail addresses there and every Gmail customer's digest changes, detaching
 * new conversions from the match history already built against the old one.
 *
 * Google's two divergences:
 *
 *   EMAIL — dots and `+suffixes` are removed from gmail.com and googlemail.com
 *   local parts, because Google itself treats them as the same mailbox. They
 *   are NOT removed elsewhere, where a dot is a significant character and
 *   removing it would produce a digest for an address that does not exist.
 *
 *   PHONE — E.164 WITH the leading plus. advanced-matching.ts strips it,
 *   correctly, because that is what TikTok wants.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lowercased, trimmed, Gmail-canonicalised. Null for anything not an address. */
export function normalizeGoogleEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;

  const at = value.lastIndexOf("@");
  const domain = value.slice(at + 1);
  if (!GOOGLE_MAIL_DOMAINS.has(domain)) return value;

  // Gmail only. A dot is significant in most local parts.
  const local = value.slice(0, at).split("+")[0].replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * E.164 including the leading plus, which is what Google expects and the
 * opposite of what the TikTok normaliser produces.
 */
export function normalizeGooglePhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export type GoogleIdentity = {
  hashedEmail?: string;
  hashedPhone?: string;
};

/**
 * Build the identity, omitting anything we do not genuinely have.
 *
 * An empty or placeholder value is worse than an absent one: it pollutes the
 * match set with a digest of the empty string, which every customer lacking
 * that field would share.
 */
export function buildGoogleIdentity(input: {
  email?: string | null;
  phone?: string | null;
}): GoogleIdentity | null {
  const identity: GoogleIdentity = {};

  const email = normalizeGoogleEmail(input.email);
  if (email) identity.hashedEmail = sha256(email);

  const phone = normalizeGooglePhone(input.phone);
  if (phone) identity.hashedPhone = sha256(phone);

  return Object.keys(identity).length > 0 ? identity : null;
}
