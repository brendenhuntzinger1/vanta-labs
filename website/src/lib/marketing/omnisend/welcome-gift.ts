import "server-only";

import { unshippableGiftSlugsFor } from "@/lib/cart-recovery";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { giftDisplayName } from "@/lib/marketing/omnisend/cart-plan";
import type { GiftFacts } from "@/lib/marketing/omnisend/contact-payload";
import { issueCustomerOffer, OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { WELCOME_GIFT_OFFER_KEY, WELCOME_GIFT_PRODUCT_SLUG } from "@/lib/offers/welcome-offer-terms";
import { siteUrl } from "@/lib/site-identity";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * THE FREE GHK-CU HALF OF THE WELCOME OFFER (lib/offers/welcome-offer-terms.ts).
 *
 * The other half is the 15% code codes.ts mints; both are minted by
 * hooks.ts onMarketingOptIn for an address that has just become
 * email-subscribed with no paid order behind it, and both reach Omnisend as
 * contact properties on the same push (contact-payload.ts vl_welcome_gift*
 * beside vl_welcome_code). The welcome-offer email shows the gift card only
 * where vl_welcome_gift_ready is "yes" (a segment split, never a blank card).
 *
 * THE TOKEN IS A BEARER SECRET AND IS NEVER PERSISTED. issueCustomerOffer
 * stores only its hash; the token lives in the claim link this module builds
 * and in the contact property that carries the link, and nowhere else. If
 * the push that carries it is refused, the row is stranded and expires on
 * its own, which is the safe direction (customer-offers.ts). A later push
 * cannot rebuild the link, so it leaves the properties alone (liveWelcomeGift
 * answers `undefined`) rather than clearing a gift that may be in an inbox.
 *
 * WHAT CAN SHIP IS THE ONLY THING PROMISED. The same shippability test the
 * cart-recovery ladder applies (unshippableGiftSlugsFor) runs before the
 * mint: a welcome email promising a vial the box will not hold is the one
 * failure this programme cannot afford, so an out-of-stock GHK-Cu means no
 * gift and the offer email carries the code alone.
 *
 * Never throws: every caller is a marketing hook on a request path, and no
 * sign-up may fail over a gift.
 */

const LOG = "[omnisend/welcome-gift]";

/** The click-tracker path that sets the vl_offer cookie and lands on the catalogue. */
function claimPath(token: string): string {
  const landing = `${siteUrl()}/products`;
  return `/api/email/track/click?url=${encodeURIComponent(landing)}&o=${encodeURIComponent(token)}`;
}

/**
 * Mint the welcome gift for an address and describe it for the contact push.
 *
 * `link` wraps the claim path in the contact's own signed door (hooks.ts
 * contactLinkFor), passed in rather than imported so this module and hooks.ts
 * do not import each other. Returns null when nothing NEW was minted: the
 * address already holds a live gift (the ordinary case on a second opt-in,
 * and its link is already in Omnisend), the vial cannot ship, or the
 * database refused. A null caller passes `undefined` to the push, which
 * leaves whatever Omnisend holds.
 */
export async function mintWelcomeGift(email: string, link: (path: string) => Promise<string>, now = Date.now()): Promise<GiftFacts | null> {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return null;
  try {
    const config = OFFER_CATALOG[WELCOME_GIFT_OFFER_KEY];
    const slug = config.reward.kind === "free_product" ? config.reward.productSlug : WELCOME_GIFT_PRODUCT_SLUG;
    const [unshippable, products] = await Promise.all([unshippableGiftSlugsFor([slug]), getCatalogProductsBySlugs([slug])]);
    if (unshippable.has(slug)) {
      console.warn(LOG, "gift not minted: the vial cannot ship", { slug });
      return null;
    }
    const issued = await issueCustomerOffer({ offerKey: WELCOME_GIFT_OFFER_KEY, email: address, automationKey: "omnisend_welcome", now });
    if (!issued) return null;
    const name = giftDisplayName(slug, products.find((product) => product.slug === slug)?.name);
    return {
      text: `a free ${name}`,
      link: await link(claimPath(issued.token)),
      minCartCents: config.minSubtotalCents,
      endsAt: issued.expiresAt,
    };
  } catch (error) {
    console.error(LOG, "mintWelcomeGift failed", error);
    return null;
  }
}

/**
 * What a push that did not mint the gift should say about it: `undefined`
 * (leave the five properties as they are) while a live, unredeemed,
 * unrevoked, unexpired row exists, `null` (clear them) when none does, so an
 * expired or spent gift stops showing on the next reconcile. An unreadable
 * table preserves: nothing is cleared on a guess. Same contract as the
 * recovery gift's liveRecoveryGift in reconcile.ts.
 */
export async function liveWelcomeGift(email: string, now = Date.now()): Promise<null | undefined> {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return undefined;
  try {
    const { data, error } = await supabaseAdmin
      .from("customer_offers")
      .select("id")
      .eq("offer_key", WELCOME_GIFT_OFFER_KEY)
      .eq("email", address)
      .is("revoked_at", null)
      .is("redeemed_at", null)
      .gt("expires_at", new Date(now).toISOString())
      .limit(1);
    if (error) {
      console.error(LOG, "welcome gift read refused; gift properties left as they are", error.message);
      return undefined;
    }
    return Array.isArray(data) && data.length > 0 ? undefined : null;
  } catch (error) {
    console.error(LOG, "welcome gift read failed; gift properties left as they are", error);
    return undefined;
  }
}
