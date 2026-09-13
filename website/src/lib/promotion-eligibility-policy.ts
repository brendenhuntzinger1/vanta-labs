
// ---------------------------------------------------------------------------
// WHO IS ASKING, AND WHETHER THE ANSWER TELLS THEM ANYTHING THEY DID NOT KNOW.
//
// /api/catalog/promotions/eligibility answers "has this address used up a
// one-per-customer promotion?" for an arbitrary email. AUTH-4 rate limited it
// because that is an existence oracle for a research-peptide store's customer
// list, and the budget it chose — ten requests per ten minutes per IP — was
// sized for an endpoint "a real cart asks a handful of times per session".
//
// THAT PREMISE WAS WRONG, AND THE COST LANDED ON CHECKOUT. The cart asks once
// per PAGE VIEW while signed in, so the tenth page of an ordinary browse is
// refused; measured on the harness, the denial landed on /checkout itself. A
// refused lookup leaves the cart believing nothing is exhausted, so it keeps
// previewing a promotion the server is about to drop, sends a total below the
// server's own, and quote-order refuses the sale with "Altered total detected".
// The guard meant to protect customer privacy was blocking purchases.
//
// THE FIX IS TO LIMIT THE ORACLE, NOT THE SHOPPER, and those are separable
// because the oracle only exists when the address asked about is NOT the
// asker's own:
//
//   * A signed-in customer asking about THEIR OWN address learns nothing. The
//     server already knows who they are; their own order history is on their
//     own account page. There is no disclosure to meter, so this path is
//     bounded only against denial of service.
//
//   * A signed-in customer asking about SOMEBODY ELSE'S address is the oracle,
//     in full. The cart never does this on its own — the only legitimate source
//     is a shopper typing a different address into the checkout email field —
//     so it stays tight.
//
// EVERY BUDGET IS KEYED ON SOMETHING THE ASKER OWNS — an account id, or the
// cart a signed recovery grant names — rather than on an IP. That is what makes
// shared Wi-Fi, an office and carrier-grade NAT safe: today one customer on a
// CGNAT range can exhaust the budget for every other customer behind it, and
// they would each be refused for traffic they never sent. An identity-keyed
// budget cannot be exhausted by a stranger.
//
// The third-party path keeps a per-IP ceiling ON TOP of its per-identity
// budget, because that is the path worth amplifying: one host cycling accounts
// is the mass-probe shape, and a legitimate shopper almost never reaches it.
// No ceiling sits on the self path, where amplification buys an attacker
// nothing but answers about addresses they already control.
// ---------------------------------------------------------------------------

/** The window every budget below is measured over. */
export const ELIGIBILITY_WINDOW_SECONDS = 10 * 60;

/**
 * Asking about your own address. Sized so it cannot be reached by browsing:
 * one lookup per page view, several tabs, a reload loop and a checkout still
 * sit far beneath it, while it remains a bound on a runaway client.
 */
export const ELIGIBILITY_SELF_LIMIT = 120;

/**
 * Asking about an address that is not yours. This is the oracle, and it is the
 * budget AUTH-4 actually meant to set. Fifteen covers a shopper who mistypes a
 * guest address a few times; it does not cover enumeration.
 */
export const ELIGIBILITY_PROBE_LIMIT = 15;

/**
 * A ceiling on third-party probes from one host, whatever identity they wear.
 * Well above any real shopper, well below a useful enumeration rate.
 */
export const ELIGIBILITY_PROBE_IP_CEILING = 60;

/**
 * A guest holding a signed cart-recovery grant. Keyed on the cart the grant
 * names, so one grant-holder cannot spend another's budget even from the same
 * carrier NAT. Reaching this endpoint at all already requires a grant this
 * server signed.
 */
export const ELIGIBILITY_GRANT_LIMIT = 30;

/**
 * No session and no grant. Unreachable in normal operation — the endpoint sits
 * behind the account wall — so this is defence in depth, and it keeps AUTH-4's
 * original per-IP budget exactly.
 */
export const ELIGIBILITY_ANONYMOUS_LIMIT = 10;

export type EligibilityIdentity =
  | { kind: "user"; userId: string; email: string | null }
  | { kind: "grant"; cartId: string }
  | { kind: "anonymous" };

export type EligibilityBucket = { bucket: string; limit: number; windowSeconds: number };

/**
 * The email an address-shaped input actually refers to, or "" for anything
 * that is not one.
 *
 * Normalised the same way the route and getExhaustedPromotionIds normalise, so
 * "Person@Example.test " and "person@example.test" are one address and share
 * one budget rather than counting as two probes.
 */
export function normalizeEligibilityEmail(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text.includes("@") ? text : "";
}

/**
 * Is this request asking about its own asker?
 *
 * An empty email is "self" by the only definition that matters here: it
 * discloses nothing, because the route answers it without a lookup.
 */
export function isSelfEligibilityQuery(identity: EligibilityIdentity, email: string): boolean {
  if (!email) return true;
  return identity.kind === "user"
    && typeof identity.email === "string"
    && identity.email.trim().toLowerCase() === email;
}

/**
 * Every budget this request has to clear, in the order they are spent.
 *
 * Returned as a list rather than applied here so the policy stays pure and the
 * route keeps the only await. A request is served when every bucket allows it;
 * the first refusal answers 429.
 *
 * A per-IP ceiling appears ONLY on the paths worth amplifying. A customer
 * asking about their own address is never held behind a number the strangers
 * sharing their carrier NAT can move.
 */
export function eligibilityBudgets(
  identity: EligibilityIdentity,
  email: string,
  ip: string | null,
): EligibilityBucket[] {
  const windowSeconds = ELIGIBILITY_WINDOW_SECONDS;
  const host = ip ?? "unknown";

  if (identity.kind === "user") {
    if (isSelfEligibilityQuery(identity, email)) {
      return [{
        bucket: `promo-eligibility:self:${identity.userId}`,
        limit: ELIGIBILITY_SELF_LIMIT,
        windowSeconds,
      }];
    }
    return [
      {
        bucket: `promo-eligibility:probe:${identity.userId}`,
        limit: ELIGIBILITY_PROBE_LIMIT,
        windowSeconds,
      },
      {
        bucket: `promo-eligibility:probe-ip:${host}`,
        limit: ELIGIBILITY_PROBE_IP_CEILING,
        windowSeconds,
      },
    ];
  }

  if (identity.kind === "grant") {
    return [{
      bucket: `promo-eligibility:grant:${identity.cartId}`,
      limit: ELIGIBILITY_GRANT_LIMIT,
      windowSeconds,
    }];
  }

  // AUTH-4's original budget and its original bucket name, unchanged: with no
  // session and no grant there is nothing better to key on than the host.
  return [{
    bucket: `promo-eligibility:${host}`,
    limit: ELIGIBILITY_ANONYMOUS_LIMIT,
    windowSeconds,
  }];
}
