import "server-only";

import { cookies } from "next/headers";
import { EMAIL_GRANT_COOKIE, verifyEmailLinkGrant } from "@/lib/email/link-grant";

/**
 * Does the CURRENT request carry a valid marketing-link grant?
 *
 * WHY A PAGE NEEDS TO ASK AT ALL, when middleware already did.
 *
 * The storefront pages guard themselves a second time, deliberately — "the page
 * and route guards remain as defence in depth, because one check in one layer
 * is one deploy away from being bypassed" (access-policy.ts). Those guards ask
 * `getAuthenticatedUser()`, which answers about a SESSION and knows nothing
 * about a grant. So a grant holder passed the wall and was then redirected to
 * /account/login by the page itself.
 *
 * That was not theory. Driven against the local harness with a valid grant:
 *
 *   GET /          200   (home renders a signed-out variant, no guard)
 *   GET /research  200   (no page guard)
 *   GET /cart      200   (cart grant path, already handled)
 *   GET /products  307 → /account/login?next=%2Fproducts     ← the page guard
 *
 * A middleware-only fix would have looked complete and shipped a marketing
 * programme whose every click still died, one layer further in. This is the
 * function the two catalogue guards consult so they agree with the wall.
 *
 * IT DOES NOT WIDEN ANYTHING. The same signed, expiring, identity-free
 * capability the wall accepts, verified the same way, and only ever consulted
 * on pages the grant's own allowlist already covers. A page NOT on that
 * allowlist — anything under /account — never calls this and is unaffected.
 *
 * Never throws: a page that cannot read its own cookies treats the visitor as
 * having no grant, which is the direction that asks someone to sign in rather
 * than the one that shows the catalogue to a stranger.
 */
export async function requestHasEmailLinkGrant(): Promise<boolean> {
  try {
    const token = (await cookies()).get(EMAIL_GRANT_COOKIE)?.value;
    return (await verifyEmailLinkGrant(token)) !== null;
  } catch {
    return false;
  }
}
