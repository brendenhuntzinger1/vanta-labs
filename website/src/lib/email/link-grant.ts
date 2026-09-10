/**
 * THE MARKETING-LINK GRANT.
 *
 * WHY IT EXISTS. `access-policy.ts` makes this store account-only by default,
 * and every destination a marketing email points at is behind that wall.
 * Verified against production on 2026-09-08, signed out:
 *
 *   GET /products        307  /account/login?next=%2Fproducts
 *   GET /cart            307  /account/login?next=%2Fcart
 *   GET /account/orders  307  /account/login?next=%2Faccount%2Forders
 *
 * Those are the exact `cta_path` values every campaign and every one of the six
 * retention automations carries. The click tracker at /api/email/click is
 * public, so the click was recorded and the attribution cookie was set — and
 * then the shopper was handed a sign-in page. The programme could record a
 * click and could never record the conversion that followed it. This is the
 * same defect cart recovery had (F-0); the fix there was cart-scoped and never
 * reached campaigns or automations.
 *
 * THE THING THAT MAKES THIS DIFFERENT FROM SIMPLY OPENING THE DOOR.
 *
 * The 21+ and research-use-only representations are not collected by a separate
 * age gate any more. They are two required tick boxes on the sign-in form
 * itself (account-auth-form.tsx), which means the wall and the age gate are the
 * same screen. Waving email clickers past the wall would wave them past the
 * attestation, and this store sells 21+ research-use-only material.
 *
 * So a grant is minted ONLY for a recipient whose account already carries both
 * representations — checked server-side at click time, against auth.users, in
 * mintable-for.ts's terms. Nobody skips the statement; they are simply not made
 * to re-make it in order to read an email they opted into. Measured against the
 * live list on 2026-09-08: 45 of 47 subscribers have an account and all 45 are
 * attested, so the rule covers the list without costing the compliance record.
 * The other two go to sign-in and attest there, which is correct — they never
 * have.
 *
 * WHAT THIS IS NOT. Not a session. It carries no user id, establishes no
 * identity, and unlocks no account, order, profile, partner or admin surface.
 * It is a capability to BROWSE AND BUY, and the allowlist below is closed for
 * that reason.
 *
 * WHY IT CARRIES NO IDENTITY. The obvious design signs the recipient's address
 * into the token. Nothing downstream needs it — the grant opens catalogue and
 * checkout, both of which already treat the holder as a guest — so signing it
 * in would put an email address in a cookie to no purpose. The capability says
 * "the bearer followed a genuine link belonging to an attested recipient", and
 * that is the whole of what it needs to say.
 *
 * WHAT IT DOES NOT DEFEND AGAINST, stated plainly: a recipient who FORWARDS
 * their email hands the forwardee the same capability, for up to seven days.
 * That is inherent to any emailed link and is the same exposure the cart grant
 * already accepts. It is bounded three ways — the grant expires, it opens
 * nothing personal, and it cannot be minted at all without a genuine
 * HMAC-signed link belonging to an attested account.
 *
 * THE CONSTRUCTION
 *
 *   v1.<expiresAtMs>.<hmac-sha256 truncated to 32 hex>
 *
 * signed over `email_link_grant:v1:<expiresAtMs>`.
 *
 *   * NAMESPACED. `email_link_grant:` is provably disjoint from
 *     `cart_recovery_grant:`, so a token minted for one cannot verify as the
 *     other even though both sign with the same secret.
 *   * THE EXPIRY IS INSIDE THE SIGNATURE, so it cannot be extended by editing
 *     the cookie. A lifetime the client can change is not a lifetime.
 *   * VERSIONED, so the scheme can be rotated without honouring old shapes.
 *   * TIMING-SAFE COMPARISON, so the signature cannot be discovered a byte at
 *     a time.
 *
 * WEB CRYPTO, NOT node:crypto, AND THAT IS NOT A STYLE CHOICE. middleware.ts
 * imports this, and Next compiles middleware for the EDGE runtime, which has no
 * Node crypto module. The same mistake in cart-recovery-grant.ts failed the
 * production build outright while every unit test passed, because the tests run
 * under Node. Only the build catches it.
 */

/**
 * Seven days, deliberately matching ATTRIBUTION_WINDOW_DAYS in campaign-links.
 *
 * A click credited to a campaign and a click able to reach the store should
 * stop meaning something on the same day: a grant that outlived the attribution
 * window would let someone buy through a link the report no longer counts.
 * Shorter than the cart grant's fourteen days because a cart is a specific
 * unfinished thing worth holding open, and a broadcast is not.
 */
export const EMAIL_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** httpOnly: a bearer capability, and no script needs to read it. */
export const EMAIL_GRANT_COOKIE = "vl_email_grant";

export const EMAIL_GRANT_MAX_AGE_SECONDS = Math.floor(EMAIL_GRANT_TTL_MS / 1000);

const VERSION = "v1";
/** Version + expiry + 32 hex. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 128;

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign marketing link grants (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signature(expiresAtMs: number): Promise<string> {
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
    encoder.encode(`email_link_grant:${VERSION}:${expiresAtMs}`),
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
 * Mint a grant.
 *
 * Returns null rather than throwing when no secret is configured: a marketing
 * email that cannot mint a grant should still send, still track and still
 * redirect. Its links then behave exactly the way every link behaved before
 * this module existed, which is a worse outcome than this and a much better one
 * than a failed send.
 */
export async function signEmailLinkGrant(now: number = Date.now()): Promise<string | null> {
  try {
    const expiresAtMs = now + EMAIL_GRANT_TTL_MS;
    return `${VERSION}.${expiresAtMs}.${await signature(expiresAtMs)}`;
  } catch {
    return null;
  }
}

/**
 * Verify a grant.
 *
 * Null for every failure — malformed, wrong version, bad signature, expired, or
 * stamped further out than the TTL allows — with no distinction between them,
 * because the difference is only ever useful to somebody probing.
 */
export async function verifyEmailLinkGrant(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<{ expiresAtMs: number } | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

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
  if (expiresAtMs > now + EMAIL_GRANT_TTL_MS) return null;

  let expected: string;
  try {
    expected = await signature(expiresAtMs);
  } catch {
    return null;
  }
  if (!constantTimeEqual(provided, expected)) return null;

  return { expiresAtMs };
}

/**
 * WHAT A GRANT UNLOCKS. A CLOSED LIST, AND DELIBERATELY SO.
 *
 * Deny by default, matching the storefront policy it sits beside: "a new route
 * is protected on the day it is created, by doing nothing." Every entry is
 * something the read-the-email-then-buy journey provably needs.
 *
 * DELIBERATELY ABSENT, each for a reason:
 *
 *   /account/*         profile, orders, addresses, saved payment. This is the
 *                      customer's own data and wants a real session. Two
 *                      automations (post_purchase, replenishment) point their
 *                      CTA at /account/orders, and those recipients will still
 *                      be asked to sign in. That is the correct answer for a
 *                      link to somebody's order history, and it is why
 *                      ctaPathReachesStore() below exists: the composer tells
 *                      an operator which of the two they have chosen instead of
 *                      letting them find out from a conversion rate.
 *   /api/account/*     the same data behind the same reasoning. The cart page
 *                      calls /api/account/me and gets 401, so it renders
 *                      without member pricing — correct for a grant holder,
 *                      who is not signed in.
 *   /admin, /api/admin the owner's surface.
 *   /vault, /partner   their own authentication boundaries.
 *
 * The cart-and-checkout half is imported from the cart grant rather than
 * retyped, so the two capabilities cannot drift apart on the paths they share.
 */
import { GUEST_GRANT_EXACT, GUEST_GRANT_PREFIXES } from "@/lib/cart-recovery-grant";

/**
 * The browsing half: what an email's button may legitimately point at.
 *
 * `/` is included because a broadcast announcing a sale reasonably links to the
 * home page. It was the homepage promotion banner leaking to anonymous
 * requests that closed the store in the first place — but a grant holder is not
 * an anonymous request. They are an opted-in subscriber who followed an
 * HMAC-signed link addressed to their own attested account.
 */
export const EMAIL_GRANT_BROWSE_EXACT = new Set<string>([
  "/",
  "/products",
  "/research",
  // THE COA LIBRARY, because an email already sends people to it.
  //
  // The 12-hour recovery message is built entirely around this page — "Every
  // production batch is filed in our COA library. You can search it by
  // product, batch or lot number and read the report itself, before you
  // order" — and it is the best-opening message the system sends, at 59%.
  // Verified against production on 2026-09-10, signed out:
  //
  //   GET /coa-library   307  /account/login?next=%2Fcoa-library
  //
  // So the one link answering the objection that email exists to answer landed
  // every reader on a sign-in page. It is the same defect as the campaign and
  // automation destinations, in the one place nobody had looked because it is
  // a secondary link rather than the button.
  //
  // Safe to open on the same terms as the catalogue: batch certificates are
  // product-safety documents, hold nothing personal, and are the evidence the
  // brand asks to be judged on. The grant is still minted only for an attested
  // recipient, so it opens no door the wall was protecting.
  "/coa-library",
  // What the catalogue pages fetch. Anything missing here renders as an empty
  // shelf rather than an error, which is the failure mode that looks like a
  // working site and sells nothing.
  "/api/catalog/products",
  "/api/catalog/product",
]);

export const EMAIL_GRANT_BROWSE_PREFIXES = [
  "/products/",
  "/research/",
  // A batch's own page, reached from the library above.
  "/coa-library/",
];

/** Does a grant cover this path? */
export function emailGrantAllowsPath(pathname: string): boolean {
  if (EMAIL_GRANT_BROWSE_EXACT.has(pathname)) return true;
  if (EMAIL_GRANT_BROWSE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  // Everything the cart grant opens, so a click can carry straight through to
  // a completed order without a second credential.
  if (GUEST_GRANT_EXACT.has(pathname)) return true;
  return GUEST_GRANT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Will a stored `cta_path` actually land a grant holder on the store?
 *
 * Exported for the admin composer, which is the only place this can be
 * usefully said. An operator typing /account/orders into a campaign is not
 * making a mistake — it is a legitimate destination — but they should know
 * before they press Send that those recipients meet a sign-in page, rather than
 * inferring it later from a click-to-order rate of zero.
 *
 * Query strings and fragments are stripped first: `/products?sort=new` is
 * /products as far as the wall is concerned, and matching the raw string would
 * report a false warning for an ordinary link.
 */
export function ctaPathReachesStore(ctaPath: string | null | undefined): boolean {
  const raw = String(ctaPath ?? "").trim();
  if (!raw.startsWith("/")) return false;
  const pathname = raw.split(/[?#]/)[0];
  return emailGrantAllowsPath(pathname);
}

/** Read the grant cookie off a request. */
export function readEmailGrantCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== EMAIL_GRANT_COOKIE) continue;
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    return value && value.length <= MAX_TOKEN_LENGTH ? value : null;
  }
  return null;
}
