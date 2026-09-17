/**
 * THE ATTESTATION HANDOFF.
 *
 * WHAT IT IS FOR. link-grant.ts mints a marketing-link grant only for an
 * address whose auth account already carries the 21+ and research-use
 * representations, and fails closed otherwise. That is right — this store sells
 * 21+ research-use-only material and the wall and the age gate are the same
 * screen — but it left a real customer with nowhere to go. A lapsed buyer who
 * never made the representations clicked a genuine win-back, holding a real
 * minted gift, and met a sign-in page for an account they may not even have.
 *
 * That module measured the exception as two subscribers out of forty-seven on
 * 2026-09-08 and judged it acceptable. By 2026-09-12 the list had grown to
 * eighty-five, forty of a hundred and fifty-two accounts carried no
 * attestation, and three of twelve paid customers had no account at all. The
 * exception stopped being marginal.
 *
 * So this token carries a clicker to a purpose-built attestation step and back
 * again WITHOUT the offer being lost on the way. It is a handoff, not a
 * credential: on its own it opens nothing at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   * It does not attest. Presenting one proves somebody followed a genuine
 *     link; only an explicit act on the interstitial records a representation.
 *   * It does not grant. The grant is minted after the attestation, by the
 *     existing mint, against the existing rule.
 *   * It does not infer anything from a prior purchase. Having bought before is
 *     why the customer is being written to; it is not evidence of age.
 *   * It does not carry marketing consent, in either direction.
 *
 * THE CONSTRUCTION
 *
 *   v2.<expiresAtMs>.<payload>.<hmac-sha256 truncated to 32 hex>
 *
 * where the payload is base64url( iv(12) || AES-256-GCM( JSON ) ) under a key
 * derived as SHA-256("attestation_handoff:v2:" + secret), and the whole thing
 * is signed over `attestation_handoff:v2:<expiresAtMs>:<payload>`, so every
 * field is inside the signature. Changing the address, the destination, the
 * offer or the nonce invalidates it.
 *
 * WHY THE PAYLOAD IS SEALED AND NOT MERELY ENCODED. v1 carried the JSON as
 * plain base64url, which put the recipient's address into the interstitial's
 * URL — readable in browser history, in referrers and in any log along the
 * way, for every unattested recipient of every email, in-house or Omnisend.
 * Customer data does not travel in URLs, so v2 seals the payload; the URL
 * carries an opaque string only this server can open. v1 is refused: the
 * handoff lives an hour, so nothing in flight outlives a deploy by more than
 * that, and a customer who is mid-interstitial simply clicks the link again.
 *
 * WHY THE ADDRESS IS INSIDE IT, when link-grant.ts deliberately carries no
 * identity. That module is right for a capability that only opens a catalogue.
 * This one ends in a COMPLIANCE RECORD written against a named account, so the
 * account has to be named by the signature rather than by anything the browser
 * could choose. A handoff for one address can never attest another.
 *
 * WHY IT IS SHORT-LIVED AND SINGLE-USE. A grant is a seven-day browse
 * capability and forwarding one costs a catalogue view. Writing a
 * representation on somebody else's account is a different order of thing, so
 * the window is an hour and the nonce is spent on first use — see
 * sql/attestation-handoffs.sql. Forwarding is still possible inside that hour,
 * exactly as it is for every emailed link; it is bounded rather than solved,
 * and that is stated here rather than implied.
 */

export const ATTESTATION_HANDOFF_TTL_MS = 60 * 60 * 1000;

const VERSION = "v2";
const SEAL_NAMESPACE = `attestation_handoff:${VERSION}:`;
/** Version + expiry + sealed payload + 32 hex. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 1536;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A destination is a path on this site, never a URL. */
const MAX_DEST_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
/** Opaque here; customer-offers owns its shape. */
const MAX_OFFER_TOKEN_LENGTH = 256;

export interface AttestationHandoff {
  /** The address whose account the attestation will be written against. */
  email: string;
  /** Where to return the customer once they have attested. A path, never a URL. */
  destination: string;
  /** The gift token to re-arm on the way back, if the link carried one. */
  offerToken: string | null;
  /** Spent on first use, so a forwarded link cannot be replayed. */
  nonce: string;
}

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign attestation handoffs (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The AES key: derived from the secret and this module's namespace, never the raw secret. */
async function sealingKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${SEAL_NAMESPACE}${signingSecret()}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(), encoder.encode(value)));
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  return bytesToBase64Url(bytes);
}

async function open(payload: string): Promise<string | null> {
  const bytes = base64UrlToBytes(payload);
  if (!bytes || bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) }, await sealingKey(), bytes.slice(IV_BYTES));
    return decoder.decode(opened);
  } catch {
    return null;
  }
}

async function signature(expiresAtMs: number, payload: string): Promise<string> {
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
    encoder.encode(`attestation_handoff:${VERSION}:${expiresAtMs}:${payload}`),
  );
  return toHex(mac).slice(0, 32);
}

/** Same guarantee as link-grant.ts's, and here for the same reason: node's
 *  timingSafeEqual does not exist on the edge runtime. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A DESTINATION MUST BE A PATH ON THIS SITE THAT A GRANT COULD OPEN.
 *
 * Two separate refusals, and both matter. A value that is not a site-relative
 * path would make this an open redirect — "//evil.test" and
 * "https://evil.test" are the two that catch people, and both are rejected
 * here rather than at the far end. And a path outside the grant's own
 * allowlist is refused because the handoff must not become a way to reach
 * somewhere the grant it ends in could not have reached anyway.
 */
export function isValidHandoffDestination(
  destination: string,
  allows: (pathname: string) => boolean,
): boolean {
  const value = String(destination ?? "").trim();
  if (!value || value.length > MAX_DEST_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  // "//host" and "/\host" are protocol-relative URLs, not paths.
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  const pathname = value.split("?")[0].split("#")[0];
  return allows(pathname);
}

export function normaliseHandoffEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Mint a handoff.
 *
 * Returns null rather than throwing on a missing secret or an unusable input,
 * because the caller is a redirect a customer is waiting on: the worst outcome
 * available is the sign-in page they would have reached anyway.
 */
export async function signAttestationHandoff(
  input: { email: string; destination: string; offerToken?: string | null; nonce?: string },
  now: number = Date.now(),
): Promise<string | null> {
  try {
    const email = normaliseHandoffEmail(input.email);
    const destination = String(input.destination ?? "").trim();
    const offerToken = input.offerToken ? String(input.offerToken) : null;
    if (!email || email.length > MAX_EMAIL_LENGTH || !email.includes("@")) return null;
    if (!destination || destination.length > MAX_DEST_LENGTH) return null;
    if (offerToken && offerToken.length > MAX_OFFER_TOKEN_LENGTH) return null;

    const nonce = input.nonce ?? crypto.randomUUID();
    const expiresAtMs = now + ATTESTATION_HANDOFF_TTL_MS;
    const payload = await seal(JSON.stringify({ e: email, d: destination, o: offerToken, n: nonce }));
    return `${VERSION}.${expiresAtMs}.${payload}.${await signature(expiresAtMs, payload)}`;
  } catch {
    return null;
  }
}

/**
 * Verify a handoff.
 *
 * Null for every failure — malformed, wrong version, bad signature, expired,
 * stamped further out than the TTL allows, or carrying a destination this
 * handoff has no business pointing at — with no distinction between them,
 * because the difference is only ever useful to somebody probing.
 *
 * Verifying does NOT spend the nonce. The caller spends it at the moment it
 * acts, so a customer who opens the interstitial and reads it has not silently
 * burned their own link.
 */
export async function verifyAttestationHandoff(
  token: string | null | undefined,
  options: { allows: (pathname: string) => boolean; now?: number },
): Promise<AttestationHandoff | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [version, expiresRaw, payload, mac] = parts;
  if (version !== VERSION) return null;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return null;

  const now = options.now ?? Date.now();
  if (expiresAtMs <= now) return null;
  // A token stamped further out than the TTL allows was not minted by us with
  // this secret, whatever its signature says about itself.
  if (expiresAtMs > now + ATTESTATION_HANDOFF_TTL_MS) return null;

  let expected: string;
  try {
    expected = await signature(expiresAtMs, payload);
  } catch {
    return null;
  }
  if (!constantTimeEqual(mac, expected)) return null;

  const decoded = await open(payload);
  if (!decoded) return null;
  let parsed: { e?: unknown; d?: unknown; o?: unknown; n?: unknown };
  try {
    parsed = JSON.parse(decoded) as typeof parsed;
  } catch {
    return null;
  }

  const email = normaliseHandoffEmail(typeof parsed.e === "string" ? parsed.e : "");
  const destination = typeof parsed.d === "string" ? parsed.d.trim() : "";
  const offerToken = typeof parsed.o === "string" && parsed.o ? parsed.o : null;
  const nonce = typeof parsed.n === "string" ? parsed.n : "";
  if (!email || !email.includes("@") || !nonce) return null;
  // Checked on the way OUT as well as the way in: a destination that was
  // allowed when the link was minted must still be allowed when it is used.
  if (!isValidHandoffDestination(destination, options.allows)) return null;

  return { email, destination, offerToken, nonce };
}
