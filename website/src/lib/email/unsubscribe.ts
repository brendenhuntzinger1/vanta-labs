import "server-only";
import crypto from "crypto";

// HMAC-signed unsubscribe tokens - verifiable with no DB lookup, and
// unforgeable without the server secret, so a one-click unsubscribe link
// works even for guest emails that have no account/session at all.
// Falls back to the service-role key as the signing secret (already a
// securely-held, always-present server secret in this app) rather than
// requiring a brand-new mandatory env var just for this.
function getUnsubscribeSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign unsubscribe tokens (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

export function generateUnsubscribeToken(email: string): string {
  return crypto.createHmac("sha256", getUnsubscribeSecret()).update(email.trim().toLowerCase()).digest("hex");
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  try {
    const expected = Buffer.from(generateUnsubscribeToken(email));
    const provided = Buffer.from(token);
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}
