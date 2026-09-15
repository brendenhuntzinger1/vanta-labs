/**
 * THE PER-CONTACT OMNISEND LINK TOKEN.
 *
 * WHY IT EXISTS. Every destination an Omnisend email can point at sits behind
 * the account wall (access-policy.ts), and the wall is also where the 21+ and
 * research-use attestations are collected. The in-house emails get through it
 * with a per-recipient signed click link that mints a browse grant only for a
 * recipient whose account is already attested (link-grant.ts,
 * recipient-attestation.ts). Omnisend cannot sign anything itself, so the
 * signature is minted HERE, once per contact, and stored on the contact as the
 * custom property `vl_link`. Every template link then reads it back through
 * Omnisend's personalisation tag and hands it to /api/email/omnisend-link,
 * which verifies it and does exactly what the in-house click route does.
 *
 * WHY THE ADDRESS IS INSIDE THE SIGNATURE. The in-house grant deliberately
 * carries no identity, because the click route already knows who clicked from
 * the campaign's own recipient signature. Here the token IS the recipient
 * signature: it is the only thing that ties a click back to a contact whose
 * attestation can be checked. Omnisend supplies the address beside it
 * (`[[contact.email]]`), and the two must agree, or one contact's link could
 * be replayed under another contact's address. The address never travels in a
 * cookie — the route reads it, verifies it, and forgets it.
 *
 * THE CONSTRUCTION
 *
 *   v1.<expiresAtMs>.<hmac-sha256 truncated to 32 hex>
 *
 * signed over `omnisend_link:v1:<email>:<expiresAtMs>`, with the address
 * lowercased and trimmed first so the case a mail client happens to preserve
 * cannot invalidate a genuine link.
 *
 *   * NAMESPACED. `omnisend_link:` is provably disjoint from
 *     `email_link_grant:` and `cart_recovery_grant:`, so a token minted for
 *     any of the three cannot verify as another even though all sign with the
 *     same secret.
 *   * THE EXPIRY IS INSIDE THE SIGNATURE, so it cannot be extended by editing
 *     the URL.
 *   * VERSIONED, so the scheme can be rotated without honouring old shapes.
 *   * TIMING-SAFE COMPARISON, so the signature cannot be discovered a byte at
 *     a time.
 *
 * WEB CRYPTO, NOT node:crypto, AND NO `server-only` IMPORT. This module is
 * built to be importable from middleware, which Next compiles for the EDGE
 * runtime — no Node crypto module there. cart-recovery-grant.ts made that
 * mistake once, and it failed the production build while every unit test
 * passed. link-grant.ts is the model this file copies line for line.
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

const VERSION = "v1";
/** Version + expiry + 32 hex. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 128;

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign Omnisend links (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The one spelling of an address this module signs. Omnisend lowercases
 * identifiers on its side and the contact payload lowercases before sending,
 * so the address that comes back in `[[contact.email]]` is lowercase; a token
 * signed over the operator's mixed-case input would never verify against it.
 */
function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

async function signature(email: string, expiresAtMs: number): Promise<string> {
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
    encoder.encode(`omnisend_link:${VERSION}:${email}:${expiresAtMs}`),
  );
  return toHex(mac).slice(0, 32);
}

/**
 * Constant-time string comparison.
 *
 * node:crypto.timingSafeEqual does not exist on the edge runtime, so this is
 * the same guarantee written by hand: every character is compared and the
 * result accumulated, so the loop costs the same whether the first differs or
 * the last. Length is compared first, which is not an oracle — the length of a
 * hex digest is public.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
    return `${VERSION}.${expiresAtMs}.${await signature(address, expiresAtMs)}`;
  } catch {
    return null;
  }
}

/**
 * Verify a link token against the address Omnisend sent beside it.
 *
 * Null for every failure — malformed, wrong version, bad signature, expired,
 * stamped further out than the TTL allows, or signed for a different address
 * — with no distinction between them, because the difference is only ever
 * useful to somebody probing.
 */
export async function verifyOmnisendLink(
  token: string | null | undefined,
  email: string,
  now: number = Date.now(),
): Promise<{ expiresAtMs: number } | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

  const address = normalizeEmail(email);
  if (!address) return null;

  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [version, expiryText, provided] = parts;
  if (version !== VERSION || !provided) return null;

  const expiresAtMs = Number(expiryText);
  if (!Number.isFinite(expiresAtMs) || !Number.isInteger(expiresAtMs)) return null;

  // Checked before the signature only as an optimisation, and safe because the
  // expiry is itself signed: a tampered one fails the comparison below, so
  // editing it gains an attacker nothing.
  if (expiresAtMs <= now) return null;
  // Stamped further out than the TTL permits: not minted here.
  if (expiresAtMs > now + OMNISEND_LINK_TTL_MS) return null;

  let expected: string;
  try {
    expected = await signature(address, expiresAtMs);
  } catch {
    return null;
  }
  if (!constantTimeEqual(provided, expected)) return null;

  return { expiresAtMs };
}

/**
 * The URL a template link carries, with Omnisend's personalisation tags left
 * LITERAL so Omnisend substitutes them at send time.
 *
 * The two tags must not be percent-encoded: Omnisend matches `[[...]]` as
 * written, and an encoded `%5B%5B` would go out verbatim as a broken token.
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
    "e=[[contact.email]]",
    `to=${encodeURIComponent(path)}`,
    "utm_source=omnisend",
    `utm_medium=${utm.medium}`,
    `utm_campaign=${encodeURIComponent(utm.campaign)}`,
  ];
  if (utm.content) query.push(`utm_content=${encodeURIComponent(utm.content)}`);
  return `${origin}/api/email/omnisend-link?${query.join("&")}`;
}
