import crypto from "crypto";

/**
 * One-way hash of a client IP, for records that need to tell visitors apart
 * without storing where they live.
 *
 * Campaign click logs are the case this exists for. The useful question is
 * "were these fifty clicks fifty people or one scanner?", and a stable digest
 * answers it exactly as well as the address itself. Keeping the raw value would
 * add a piece of personal data to a marketing table for no additional signal.
 *
 * Salted with a server secret so the digest cannot be reversed by hashing the
 * ~4 billion IPv4 addresses and matching — an unsalted hash of an IP is not
 * meaningfully anonymised, it is just an IP that is inconvenient to read.
 */
export function hashIpAddress(ip: string | null | undefined): string | null {
  const value = String(ip ?? "").trim();
  if (!value) return null;
  const salt = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!salt) return null;
  return crypto.createHmac("sha256", salt).update(value).digest("hex").slice(0, 32);
}
