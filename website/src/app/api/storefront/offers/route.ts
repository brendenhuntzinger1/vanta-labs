import { NextResponse } from "next/server";
import { resolveStorefrontOffers, visibleOffers } from "@/lib/storefront-offers";

// Never cached. This route mirrors the live on/off state of the promotion
// systems, so disabling a coupon or ending a sale has to take the offer down
// on the next load — a cached "15% OFF" outliving the coupon is a promise the
// checkout will refuse to keep.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public. Returns only offers that are already being honoured and are already
 * marked advertisable — see storefront-offers.ts for the exclusion list. No
 * private codes, no assigned codes, no ambassador codes, no redemption
 * counters, no internal limits.
 *
 * The layout resolves offers server-side, so this endpoint exists for clients
 * that need to re-check without a navigation (and as the documented public
 * contract). It is not on any critical path: an error returns an empty list,
 * because a promotion lookup must never be able to break the store.
 */
export async function GET() {
  try {
    const offers = visibleOffers(await resolveStorefrontOffers());
    return NextResponse.json(
      { success: true, offers },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json(
      { success: true, offers: [] },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
