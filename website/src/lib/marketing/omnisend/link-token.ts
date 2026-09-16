/**
 * THE PER-CONTACT OMNISEND LINK TOKEN.
 *
 * WHY IT EXISTS. Every destination an Omnisend email can point at sits behind
 * the account wall (access-policy.ts), and the wall is also where the 21+ and
 * research-use attestations are collected. The in-house emails get through it
 * with a per-recipient signed click link that mints a browse grant only for a
 * recipient whose account is already attested (link-grant.ts,
 * recipient-attestation.ts). Omnisend cannot sign anything itself, so the
 * token is minted HERE, once per contact, and stored on the contact as the
 * custom property `vl_link`. Every template link then reads it back through
 * Omnisend's personalisation tag and hands it to /api/email/omnisend-link,
 * which opens it and does exactly what the in-house click route does.
 *
 * WHY THE ADDRESS IS INSIDE THE TOKEN, SEALED. The token is the recipient
 * signature: it is the only thing that ties a click back to a contact whose
 * attestation can be checked, so it has to carry the address. The first
 * version carried the address BESIDE the token, as `e=[[contact.email]]`,
 * which put every recipient's address in a URL — in Omnisend's click logs, in
 * browser history, in referrer headers, in any proxy log along the way. The
 * brief is explicit that customer data does not travel in URLs, so v2 seals
 * the address into the token with authenticated encryption: the URL carries
 * an opaque string that only this server can open, and the route reads the
 * address from the opened token, verifies nothing else, and forgets it.
 *
 * THE CONSTRUCTION
 *
 *   v2.<base64url( iv(12) || AES-256-GCM( "omnisend_link:v2:<email>:<expiresAtMs>" ) )>
 *
 * with the address lowercased and trimmed first so the case a mail client
 * happens to preserve cannot invalidate a genuine link. The key is
 * SHA-256("omnisend_link:v2:" + secret), so it is derived from the same secret
 * the other grant families sign with but is not that secret and not their key.
 *
 *   * AUTHENTICATED. GCM refuses a ciphertext with a single flipped bit, so the
 *     expiry and the address cannot be edited any more than they could be
 *     under the old HMAC — and now they cannot be read either.
 *   * NAMESPACED. The plaintext starts with `omnisend_link:v2:` and the route
 *     checks it, so a sealed value from any other family (none exist today)
 *     still could not verify here.
 *   * THE EXPIRY IS INSIDE, so it cannot be extended by editing the URL, and
 *     it is also bounded above: a token stamped further out than the TTL was
 *     not minted here.
 *   * VERSIONED. The v1 shape (`v1.<expiry>.<hmac>`) is refused outright; no
 *     v1 token was ever sent to a customer.
 *   * FRESH PER MINT. A random IV means the same address yields a different
 *     token every night, so two contacts' tokens never collide and a token
 *     cannot be recognised as "the same person" from the outside.
 *
 * WEB CRYPTO, NOT node:crypto, AND NO `server-only` IMPORT. This module is
 * built to be importable from middleware, which Next compiles for the EDGE
 * runtime — no Node crypto module there. cart-recovery-grant.ts made that
 * mistake once, and it failed the production build while every unit test
 * passed. link-grant.ts is the model this file follows.
 */

import { siteUrl } from "@/lib/site-identity";

/**
 * Thirty days, deliberately longer than the seven-day browse grant it unlocks.
 *
 * The grant is minted at click time and lives seven days from THEN. The token
 * lives on the contact record and is read by every email sent in between, so
 * it has to outlast a campaign's planning horizon: a flow scheduled a fortnight
 * out must still carry a valid link when it fires. The nightly reconcile
 * refreshes it well inside the window, so a live contact never holds a stale
 * one; thirty days is the ceiling, not the working age.
 */
export const OMNISEND_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The attribution cookie the click route sets, so a later order can be
 * credited to the Omnisend campaign that brought the customer. httpOnly: no
 * script needs to read it. Named beside the token because the two are set by
 * the same route and read by the same reports.
 */
export const OMNISEND_ATTRIBUTION_COOKIE = "vl_omnisend";

const VERSION = "v2";
const NAMESPACE = `omnisend_link:${VERSION}:`;
/**
 * A sealed address of the longest length a mailbox can have (254) plus the
 * namespace, the expiry, the IV and the tag comes to about 420 characters
 * in base64url. Anything longer is not ours and is refused before any
 * decoding.
 */
const MAX_TOKEN_LENGTH = 512;
const IV_BYTES = 12;
/** GCM's authentication tag, appended to the ciphertext by Web Crypto. */
const TAG_BYTES = 16;

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign Omnisend links (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not base64url, rather than a throw from atob. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The one spelling of an address this module seals. Omnisend lowercases
 * identifiers on its side and the contact payload lowercases before sending,
 * so the address the token yields is the one every store record is keyed by.
 */
function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * The AES key: SHA-256 of the namespace and the secret. Derived rather than
 * the raw secret so the key is 32 bytes whatever the secret's length, and so
 * it is provably not the HMAC key any other grant family signs with.
 */
async function sealingKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${NAMESPACE}${signingSecret()}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Mint a link token for one contact.
 *
 * Returns null rather than throwing when no secret is configured or the
 * address is blank: a contact upsert that cannot mint a link should still
 * upsert. Its emails then link exactly as every link linked before this
 * module existed — to the sign-in page — which is a worse outcome than this
 * and a much better one than a contact Omnisend never learns about.
 */
export async function signOmnisendLink(email: string, now: number = Date.now()): Promise<string | null> {
  try {
    const address = normalizeEmail(email);
    if (!address) return null;
    const expiresAtMs = now + OMNISEND_LINK_TTL_MS;
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealingKey(), encoder.encode(`${NAMESPACE}${address}:${expiresAtMs}`)),
    );
    const bytes = new Uint8Array(iv.length + sealed.length);
    bytes.set(iv);
    bytes.set(sealed, iv.length);
    return `${VERSION}.${toBase64Url(bytes)}`;
  } catch {
    return null;
  }
}

/**
 * Open a link token and return the address it was minted for.
 *
 * Null for every failure — malformed, wrong version, tampered, expired,
 * stamped further out than the TTL allows, or sealed under another namespace
 * — with no distinction between them, because the difference is only ever
 * useful to somebody probing. The address comes ONLY from inside the token:
 * nothing on the request can name a different one.
 */
export async function verifyOmnisendLink(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<{ email: string; expiresAtMs: number } | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [version, payload] = parts;
  if (version !== VERSION || !payload) return null;

  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length <= IV_BYTES + TAG_BYTES) return null;

  let text: string;
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await sealingKey(),
      bytes.slice(IV_BYTES),
    );
    text = decoder.decode(opened);
  } catch {
    return null;
  }

  if (!text.startsWith(NAMESPACE)) return null;
  const body = text.slice(NAMESPACE.length);
  const colon = body.lastIndexOf(":");
  if (colon <= 0) return null;
  const email = body.slice(0, colon);
  const expiryText = body.slice(colon + 1);
  if (!email || email !== normalizeEmail(email) || !/^\d+$/.test(expiryText)) return null;

  const expiresAtMs = Number(expiryText);
  if (!Number.isFinite(expiresAtMs) || !Number.isInteger(expiresAtMs)) return null;
  if (expiresAtMs <= now) return null;
  // Stamped further out than the TTL permits: not minted here.
  if (expiresAtMs > now + OMNISEND_LINK_TTL_MS) return null;

  return { email, expiresAtMs };
}

/**
 * The URL a template link carries, with Omnisend's personalisation tags left
 * LITERAL so Omnisend substitutes them at send time.
 *
 * The tag must not be percent-encoded: Omnisend matches `[[...]]` as
 * written, and an encoded `%5B%5B` would go out verbatim as a broken token.
 * The address is NOT beside it: v2 seals it inside the token.
 * The site path IS encoded, because it is an ordinary query value that the
 * route decodes and then validates with resolveSitePath — nothing here decides
 * whether the path is safe, the route does, on every click.
 *
 * UTMs ride on the click link rather than being re-applied by the route from
 * stored state, because Omnisend holds no stored state the route can read. The
 * route treats them as labels only: they name a campaign in a report and in
 * the attribution cookie, and they never influence where anyone is sent.
 */
export function omnisendLinkUrl(
  path: string,
  utm: { campaign: string; medium: "email" | "sms"; content?: string },
  siteOrigin: string = siteUrl(),
): string {
  const origin = siteOrigin.replace(/\/+$/, "");
  const query = [
    "t=[[contact.custom_properties.vl_link]]",
    `to=${encodeURIComponent(path)}`,
    "utm_source=omnisend",
    `utm_medium=${utm.medium}`,
    `utm_campaign=${encodeURIComponent(utm.campaign)}`,
  ];
  if (utm.content) query.push(`utm_content=${encodeURIComponent(utm.content)}`);
  return `${origin}/api/email/omnisend-link?${query.join("&")}`;
}
