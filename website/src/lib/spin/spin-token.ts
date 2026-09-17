// ---------------------------------------------------------------------------
// THE LINK THE WIN-BACK EMAIL CARRIES.
//
// Shape: v1.<b64url(email)>.<b64url(campaignId)>.<expiryMs>.<32 hex of HMAC>
//
// Modelled on cart-recovery-grant.ts, which solved the same problem for carts,
// and deliberately written to the same rules:
//
//   * WebCrypto rather than node:crypto, so it also works on the edge runtime
//     where middleware and some routes run.
//   * VERSIONED, so the scheme can be rotated without honouring old shapes.
//   * CONSTANT-TIME COMPARISON, so the signature cannot be found a byte at a
//     time.
//   * EVERY FAILURE RETURNS NULL with no reason attached, because the
//     difference between "expired" and "forged" is only ever useful to someone
//     probing.
//
// WHY SIGNED RATHER THAN A STORED ROW. The sweep can address the whole lapsed
// list without writing a row per recipient; the row appears when somebody
// actually spins. That is also what keeps a mail scanner from consuming
// anything — see the spin route, where opening the link is a GET and spinning
// is a POST.
//
// WHY THE ADDRESS IS IN THE URL AT ALL, when the offer token pointedly is not.
// This token grants the right to spin, not a product. The prize it produces is
// minted into a customer_offers row bound to this same address and carried
// onward in an httpOnly cookie, so a Referer leak of this link costs a spin and
// never a vial. The offer token has no such property, which is why that one
// stays out of URLs.
// ---------------------------------------------------------------------------

/**
 * How long a spin link stays good.
 *
 * Longer than the 72-hour prize on purpose: this is the life of the LINK, and
 * people open marketing email late. The short clock that matters starts when
 * they spin, not when the mail lands, so a fortnight-old link opening onto a
 * live wheel is the behaviour we want rather than a bug.
 */
export const SPIN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const VERSION = "v1";

/** Version + two encoded fields + expiry + 32 hex. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 512;

const encoder = new TextEncoder();

function signingSecret(): string {
  // The same pair cart-recovery grants use, so there is one secret to rotate
  // rather than two, and a deploy that can sign one can sign the other.
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign spin links (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function encodeField(value: string): string {
  // base64url, so neither field can contain the dot that separates them. Every
  // email address contains a dot, so this is not a theoretical hazard.
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeField(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    // base64url decoding is lenient and will happily accept input that did not
    // come from encodeField. Re-encoding and comparing rejects those, so a
    // token cannot be re-spelled into a different one with the same signature.
    return encodeField(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

async function signature(email: string, campaignId: string, expiresAtMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    // The campaign is inside the signed payload, not merely beside it, so a
    // link for one campaign cannot be replayed into the next one — where the
    // recipient would have a fresh one-live-offer slot and could spin again.
    encoder.encode(`spin_link:${VERSION}:${email}:${campaignId}:${expiresAtMs}`),
  );
  return toHex(mac).slice(0, 32);
}

/**
 * Constant-time string comparison.
 *
 * node:crypto.timingSafeEqual is not available on the edge runtime, so this is
 * the same guarantee written by hand: every byte is compared and the result
 * accumulated, so the loop takes the same time whether the first byte differs
 * or the last. Comparing lengths first is not an oracle — the length of a hex
 * digest is public.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint the link for one recipient.
 *
 * Returns null rather than throwing when the address is unusable or the secret
 * is missing: a campaign send that cannot sign a link should still send the
 * rest of the batch, and one recipient without a wheel is a smaller failure
 * than a sweep that dies halfway through the list.
 */
export async function signSpinToken(
  email: string,
  campaignId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const address = String(email ?? "").trim().toLowerCase();
  const campaign = String(campaignId ?? "").trim();
  // Not a validator, a sanity check: the sweep selects real customer rows, and
  // anything without an @ is a bug upstream rather than a recipient.
  if (!address || !address.includes("@") || !campaign) return null;

  try {
    const expiresAtMs = now + SPIN_TOKEN_TTL_MS;
    const mac = await signature(address, campaign, expiresAtMs);
    return `${VERSION}.${encodeField(address)}.${encodeField(campaign)}.${expiresAtMs}.${mac}`;
  } catch {
    return null;
  }
}

/**
 * Verify a link and return who it names.
 *
 * Null for every failure — malformed, wrong version, bad signature, expired, or
 * stamped further out than the scheme mints — with no distinction between them.
 */
export async function verifySpinToken(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<{ email: string; campaignId: string } | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const [version, encodedEmail, encodedCampaign, expiryText, provided] = parts;
  if (version !== VERSION || !encodedEmail || !encodedCampaign || !provided) return null;

  const email = decodeField(encodedEmail);
  const campaignId = decodeField(encodedCampaign);
  if (!email || !campaignId) return null;

  const expiresAtMs = Number(expiryText);
  if (!Number.isFinite(expiresAtMs) || !Number.isInteger(expiresAtMs)) return null;

  // Checked before the signature only as an optimisation, and safe because the
  // expiry is itself signed: a tampered one fails the comparison below.
  if (expiresAtMs <= now) return null;
  // A link stamped further out than the TTL allows was not minted by this code
  // under this secret.
  if (expiresAtMs > now + SPIN_TOKEN_TTL_MS) return null;

  let expected: string;
  try {
    expected = await signature(email, campaignId, expiresAtMs);
  } catch {
    return null;
  }
  if (!constantTimeEqual(provided, expected)) return null;

  return { email, campaignId };
}
