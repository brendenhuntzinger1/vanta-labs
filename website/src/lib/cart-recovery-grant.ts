/**
 * THE GUEST CART-RECOVERY GRANT.
 *
 * WHY IT EXISTS. Most recovery recipients are guests: they typed an email into
 * the checkout field and never made an account. `access-policy.ts` makes the
 * store account-only by default, and `/cart`, `/cart/restore` and `/checkout`
 * are all behind that wall. So the recovery email tracked the click — the
 * tracker is public — and then redirected the shopper to a sign-in page for an
 * account they do not have. The programme could record a click and could never
 * record a conversion, which is exactly what the production data showed.
 *
 * WHAT THIS IS NOT. It is not a session. It establishes no customer identity,
 * carries no user id, and unlocks no account, profile, order or admin surface.
 * It is a capability to finish ONE named cart, and the path allowlist below is
 * a closed list for that reason.
 *
 * WHY NOT JUST TRUST THE CART UUID. A raw id is a database key that appears in
 * admin screens, logs, support threads and CSV exports, and it never expires.
 * Treating it as a credential would mean anyone who ever saw one — including a
 * former staff member reading an old export — could open that cart forever.
 * A signed grant separates "which cart" from "may open it": the id stays an
 * identifier, and the capability is a separate, expiring, unforgeable thing.
 *
 * THE CONSTRUCTION
 *
 *   v1.<cartId>.<expiresAtMs>.<hmac-sha256 truncated to 32 hex>
 *
 * and the signature covers `cart_recovery_grant:v1:<cartId>:<expiresAtMs>`.
 *
 *   * NAMESPACED. The prefix makes this token space provably disjoint from the
 *     automation and campaign links, which sign with the same secret. Without
 *     it, a token minted for one could verify as the other.
 *   * THE EXPIRY IS INSIDE THE SIGNATURE, so it cannot be extended by editing
 *     the cookie. A lifetime the client can change is not a lifetime.
 *   * THE CART ID IS INSIDE THE SIGNATURE, so a grant for one cart cannot be
 *     repointed at another. This is the whole of "no access to another
 *     customer's cart", and it is enforced again at the route, which checks
 *     that the grant names the cart being asked for.
 *   * VERSIONED, so the scheme can be rotated without honouring old shapes.
 *   * TIMING-SAFE COMPARISON, so the signature cannot be discovered a byte at
 *     a time.
 *
 * Everything is verified server-side, every failure returns null with no reason
 * attached, and null is treated as "no grant" — never as an error the caller
 * might be tempted to fall open on.
 *
 * WEB CRYPTO, NOT node:crypto, AND THAT IS NOT A STYLE CHOICE. This module is
 * imported by middleware.ts, which Next compiles for the EDGE runtime — and the
 * edge runtime has no Node crypto module. `import crypto from "crypto"` here
 * failed the production build outright:
 *
 *   Ecmascript file had an error
 *   Import traces: ./src/lib/cart-recovery-grant.ts -> ./middleware.ts
 *
 * The unit tests passed throughout, because they run under Node. Only the build
 * catches it. Web Crypto is present in both runtimes, which is why sign and
 * verify are async — the cost is one await in an already-async middleware.
 */

/** Fourteen days. Long enough that a click on day four still works, and
 *  bounded so a forwarded email does not open a cart indefinitely. */
export const GUEST_GRANT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** httpOnly: this is a bearer capability, and no script needs to read it. */
export const GUEST_GRANT_COOKIE = "vl_cart_grant";

export const GUEST_GRANT_MAX_AGE_SECONDS = Math.floor(GUEST_GRANT_TTL_MS / 1000);

/** The query parameter the restore link carries, exchanged for the cookie. */
export const GUEST_GRANT_PARAM = "k";

const VERSION = "v1";
/** A token is version + id + expiry + 32 hex. Anything longer is not ours. */
const MAX_TOKEN_LENGTH = 256;

function signingSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("No secret available to sign cart-recovery grants (set UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY)");
  }
  return secret;
}

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signature(cartId: string, expiresAtMs: number): Promise<string> {
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
    encoder.encode(`cart_recovery_grant:${VERSION}:${cartId}:${expiresAtMs}`),
  );
  return toHex(mac).slice(0, 32);
}

/**
 * Constant-time string comparison.
 *
 * node:crypto.timingSafeEqual is not available on the edge runtime, so this is
 * the same guarantee written by hand: every byte is compared and the result is
 * accumulated, so the loop takes the same time whether the first byte differs
 * or the last. Lengths are compared first because an early return on length is
 * not a signature oracle — the length of a hex digest is public.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a grant for one cart.
 *
 * Returns null rather than throwing when there is no cart id or no secret: a
 * recovery email that cannot mint a grant should still send and still track,
 * it simply will not carry one. Failing the send would be a worse outcome than
 * a link that behaves the way every link behaved before this existed.
 */
export async function signGuestRecoveryGrant(
  cartId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const id = String(cartId ?? "").trim();
  // A dot is the field separator, so an id containing one would make the token
  // ambiguous. Cart ids are UUIDs; anything else is not something to sign.
  if (!id || id.includes(".")) return null;
  try {
    const expiresAtMs = now + GUEST_GRANT_TTL_MS;
    return `${VERSION}.${id}.${expiresAtMs}.${await signature(id, expiresAtMs)}`;
  } catch {
    return null;
  }
}

/**
 * Verify a grant and return the cart it names.
 *
 * Null for every failure — malformed, wrong version, bad signature, expired,
 * or minted in the future — with no distinction between them, because the
 * difference is only ever useful to someone probing.
 */
export async function verifyGuestRecoveryGrant(
  token: string | null | undefined,
  now: number = Date.now(),
): Promise<{ cartId: string; expiresAtMs: number } | null> {
  const raw = String(token ?? "").trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;

  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [version, cartId, expiryText, provided] = parts;
  if (version !== VERSION || !cartId || !provided) return null;

  const expiresAtMs = Number(expiryText);
  if (!Number.isFinite(expiresAtMs) || !Number.isInteger(expiresAtMs)) return null;

  // EXPIRY IS CHECKED BEFORE THE SIGNATURE ONLY AS AN OPTIMISATION, and it is
  // safe because the expiry is itself signed: a tampered one produces a
  // signature mismatch below, so an attacker gains nothing by editing it.
  if (expiresAtMs <= now) return null;
  // A grant stamped further out than the TTL allows was not minted here.
  if (expiresAtMs > now + GUEST_GRANT_TTL_MS) return null;

  let expected: string;
  try {
    expected = await signature(cartId, expiresAtMs);
  } catch {
    return null;
  }
  if (!constantTimeEqual(provided, expected)) return null;

  return { cartId, expiresAtMs };
}

/**
 * WHAT A GRANT UNLOCKS. A CLOSED LIST, AND DELIBERATELY A SHORT ONE.
 *
 * Deny by default, exactly like the storefront policy it sits beside. A grant
 * lets someone finish a cart; it must not become a general key to the gated
 * store, so every entry here is something the cart-to-purchase journey provably
 * needs, and was added by driving that journey in a browser and reading the
 * 401s rather than by guessing.
 *
 * DELIBERATELY ABSENT, and each for a reason:
 *
 *   /api/account/*     account data. The cart page calls /api/account/me and
 *                      /api/account/ambassador-discount; a guest gets 401 from
 *                      both and the page renders without member pricing, which
 *                      is correct — a guest has none.
 *   /account/*         profile, orders, addresses.
 *   /products, /       the catalogue itself. A grant is for finishing ONE cart,
 *                      not for browsing the store the wall exists to gate.
 *   /admin, /vault     nothing here ever touches those.
 */
export const GUEST_GRANT_EXACT = new Set([
  "/cart",
  "/cart/restore",
  "/checkout",
  "/api/cart/restore",
  "/api/cart/validate",
  "/api/cart/track",
  "/api/checkout/create-session",
  // WHAT PRICES THE GIFT. Missing here, and the omission was invisible because
  // the gift still worked — it just was not SHOWN.
  //
  // cart-client.tsx: "The drawer and the checkout summary already price an
  // armed offer through /api/checkout/quote, so a shopper who clicked the
  // win-back link sees the $0 vial and the waived shipping wherever they look."
  // Every one of those calls answered 401 for a grant holder, so a guest
  // arriving on a recovery link saw a cart total that did not include the gift
  // they had been mailed — the exact defect that comment was written to fix,
  // reintroduced for the one audience the grant exists to serve.
  //
  // Safe to open, on the endpoint's own terms: "quoteOrder takes no lock and
  // reserves nothing, in any mode. Nothing here writes. The response carries NO
  // token. The gift is described, never granted." It prices the items in the
  // request body and discloses nothing about anyone else.
  "/api/checkout/quote",
  "/api/coupons/validate",
  "/api/offer/status",
  "/api/catalog/promotions",
  "/api/catalog/promotions/eligibility",
  "/api/catalog/bulk-savings-config",
  "/api/catalog/payment-methods",
]);

/**
 * Prefixes, for the pages that carry an id. Each of these already defends
 * itself with an unguessable order id, which is why the prefix is safe: the
 * grant gets a guest THROUGH the wall, and the route still decides whether
 * this particular order is theirs to see.
 */
export const GUEST_GRANT_PREFIXES = [
  "/checkout/pay/",
  "/pay/",
  "/order-confirmation/",
  // THE POLL THOSE THREE PAGES DEPEND ON.
  //
  // /checkout/pay and /pay are on this list, and both poll
  // /api/checkout/order-status/<orderId> to notice that the payment settled.
  // The route was NOT, so for a grant-holding guest the poll answered 401 for
  // ever: the page sat on "confirming your payment" after the money had
  // actually moved, which produces a second payment attempt and a support
  // ticket. The completion fallback was dead for precisely the audience the
  // cart grant exists to convert.
  //
  // Safe on the same terms as the three above, and for the same stated reason:
  // the route defends itself with an unguessable order id and re-checks
  // nothing else, so the grant gets the guest THROUGH the wall while the route
  // still decides whether this order is theirs to see.
  "/api/checkout/order-status/",
];

export function guestGrantAllowsPath(pathname: string): boolean {
  if (GUEST_GRANT_EXACT.has(pathname)) return true;
  return GUEST_GRANT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Read the grant cookie off a request. */
export function readGuestGrantCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== GUEST_GRANT_COOKIE) continue;
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    return value && value.length <= MAX_TOKEN_LENGTH ? value : null;
  }
  return null;
}
