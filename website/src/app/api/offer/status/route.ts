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
  if (!status || !isOfferKey(status.offerKey)) {
    return NextResponse.json({ offer: null });
  }

  // The display name comes from the catalogue rather than from the offer row,
  // so a renamed product reads correctly in a banner shown weeks after the
  // token was minted.
  let productName: string = OFFER_CATALOG[status.offerKey].label;
  try {
    const [product] = await getCatalogProductsBySlugs([status.productSlug]);
    if (product?.name) productName = product.name;
  } catch {
    // The catalogue being unavailable is not a reason to hide the offer.
  }

  return NextResponse.json({
    offer: {
      productName,
      minSubtotalCents: status.minSubtotalCents,
      expiresAt: status.expiresAt,
    },
  });
}
