import { NextResponse } from "next/server";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { OFFER_CATALOG, isOfferKey, readOfferCookie, readOfferStatus } from "@/lib/offers/customer-offers";

export const dynamic = "force-dynamic";

/**
 * What free gift, if any, is waiting for this browser.
 *
 * Exists so the cart can SHOW the offer. A gift the customer only discovers on
 * the confirmation screen does not change what they put in the basket, which is
 * the entire point of attaching one to a win-back.
 *
 * IT READS THE COOKIE AND RETURNS NO SECRET. The token never appears in the
 * response; only the product name, the minimum and the expiry — which is
 * exactly what the customer's own email already told them. It grants nothing:
 * the free line is added by quoteOrder from the same cookie, server-side, and
 * is bound to the checkout email under a lock at reservation.
 *
 * Always 200. A missing, spent or expired offer is `{ offer: null }`, not an
 * error — the cart renders no banner and nothing looks broken.
 */
export async function GET(request: Request) {
  const status = await readOfferStatus(readOfferCookie(request));
  // A LIVE OFFER IS A LIVE OFFER, WHETHER OR NOT ITS KEY IS IN THE CATALOGUE.
  //
  // This used to also require `isOfferKey(status.offerKey)`, which was true of
  // every offer that existed when it was written. A campaign gift files under
  // `campaign:<id>` deliberately — that is what gives one live gift per
  // recipient PER CAMPAIGN rather than one ever — so the check silently hid
  // every campaign gift from the cart banner.
  //
  // The failure mode was the quiet kind: the token still worked, quoteOrder
  // still priced the gift from the offer row, and the customer was simply never
  // told they had one. Caught by following a real delivered email through the
  // local harness, not by reading this file.
  if (!status) {
    return NextResponse.json({ offer: null });
  }

  // What to call the gift in the cart.
  //
  // A product gift is named from the CATALOGUE rather than from the offer row,
  // so a renamed product reads correctly in a banner shown weeks after the
  // token was minted. A shipping gift has no product to name, so it falls back
  // to the catalogue entry's own label.
  // A MULTI-ITEM GIFT IS NAMED FROM ITS ITEMS, NOT FROM ITS KEY.
  //
  // Cart-recovery gifts file under a stable slot key that happens to BE a
  // catalogue key (`cart_recovery_bac_water`, kept so the one-live-offer index
  // and the 30-day cooldown do not reset). So the catalogue branch below
  // matched and the cart banner said "Free BAC Water" for a gift of three
  // different products. The row is what the checkout honours, so the row is
  // what the banner must name. Caught by taking a real top-band recovery email
  // through the click and reading what the cart said.
  if (status.giftItems.length > 0) {
    let names = status.giftItems.map((item) => item.slug);
    try {
      const products = await getCatalogProductsBySlugs(status.giftItems.map((item) => item.slug));
      names = status.giftItems.map((item) => {
        const product = products.find((candidate) => candidate.slug === item.slug);
        const name = product?.name ?? item.slug;
        return item.quantity > 1 ? `${item.quantity} × ${name}` : name;
      });
    } catch {
      // The catalogue being unavailable is not a reason to hide the gift.
    }
    return NextResponse.json({
      offer: {
        rewardKind: status.rewardKind,
        rewardName: names.join(" + "),
        minSubtotalCents: status.minSubtotalCents,
        expiresAt: status.expiresAt,
      },
    });
  }

  // A catalogue gift keeps the label that was written for it. Anything else —
  // a gift an operator built for one campaign — is named from what the offer
  // row actually grants, because there is no catalogue entry to ask.
  let rewardName: string = isOfferKey(status.offerKey)
    ? OFFER_CATALOG[status.offerKey].label
    : status.rewardKind === "free_shipping_percent"
      ? `Free shipping + ${status.percentOff ?? 0}% off`
      : status.rewardKind === "percent"
        ? `${status.percentOff ?? 0}% off`
        : "Free shipping";
  if (status.productSlug) {
    try {
      const [product] = await getCatalogProductsBySlugs([status.productSlug]);
      if (product?.name) {
        // free_product renders as "free <name>" at the call sites; the combined
        // kind carries its own full wording, since those sites print it as-is.
        rewardName = status.rewardKind === "free_product"
          ? product.name
          : `Free ${product.name} + ${status.percentOff ?? 0}% off`;
      }
    } catch {
      // The catalogue being unavailable is not a reason to hide the offer.
    }
  }

  return NextResponse.json({
    offer: {
      rewardKind: status.rewardKind,
      rewardName,
      minSubtotalCents: status.minSubtotalCents,
      expiresAt: status.expiresAt,
    },
  });
}
