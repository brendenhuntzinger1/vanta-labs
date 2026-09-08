/**
 * CART-RECOVERY CLICK ATTRIBUTION.
 *
 * marketing-source.ts already decides one primary channel per order, ranked
 * `offer_redeemed > click > recovery_coupon > referral_code > ad_touch >
 * organic`. Cart recovery appeared only at the `recovery_coupon` tier, which
 * means an order was credited to it ONLY IF IT SPENT A `SAVE-` CODE.
 *
 * Stages 1-3 carry no code. So a shopper who clicked the first reminder and
 * checked out ten minutes later was recorded as `organic`, and the programme
 * could not demonstrate value even when it worked. On 2026-09-07 the dashboard
 * showed two recoveries, one of which had received no email at all — the
 * `abandoned_carts.status = 'recovered'` mark is set by any paid order from
 * that address inside the window, click or no click, which answers "did they
 * come back" and not "did we bring them back".
 *
 * This is the missing click signal. Deliberately the same shape as the
 * campaign and automation cookies — a separate cookie, not a prefixed value in
 * a shared one, for the reason automation-links.ts gives: an order can follow
 * clicks from more than one channel, and collapsing them silently drops
 * whichever landed second.
 *
 * NOT SIGNED, exactly like `vl_campaign`. The value is a cart id that must
 * resolve against a real row, and the only thing a forged one buys is
 * mis-crediting the forger's own order to a channel — no money moves, no
 * entitlement is granted, nothing is disclosed. The gift token that DOES carry
 * value travels in `vl_offer`, which is httpOnly and redeemed under a lock.
 */

import { ATTRIBUTION_WINDOW_MS, isWithinAttributionWindow } from "@/lib/email/campaign-links";

export { ATTRIBUTION_WINDOW_MS };

/** Its own slot, so a cart-recovery click never overwrites a campaign one. */
export const CART_RECOVERY_COOKIE = "vl_cart_recovery";

/** Matches the campaign and automation windows exactly — seven days. */
export const CART_RECOVERY_COOKIE_MAX_AGE_SECONDS = Math.floor(ATTRIBUTION_WINDOW_MS / 1000);

export function encodeCartRecoveryCookie(cartId: string, clickedAtMs: number): string {
  return `${cartId}.${clickedAtMs}`;
}

/**
 * Decode the cart-recovery attribution cookie.
 *
 * Expiry is enforced here as well as by Max-Age, for the reason
 * campaign-links.ts gives: a cookie lifetime is a request the client is free
 * to ignore, and attribution that can be extended by editing a cookie is not
 * attribution.
 */
export function decodeCartRecoveryCookie(
  value: string | null | undefined,
  now: number = Date.now(),
): { cartId: string; clickedAtMs: number } | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const cartId = value.slice(0, separator);
  const clickedAtMs = Number(value.slice(separator + 1));
  if (!cartId || !Number.isFinite(clickedAtMs)) return null;
  if (!isWithinAttributionWindow(clickedAtMs, now)) return null;
  return { cartId, clickedAtMs };
}

/** Read `vl_cart_recovery` off a request, mirroring readCampaignCookie exactly. */
export function readCartRecoveryCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CART_RECOVERY_COOKIE) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}
