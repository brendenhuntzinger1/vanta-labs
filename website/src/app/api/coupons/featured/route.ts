import { NextResponse } from "next/server";
import { getStorefrontCoupon } from "@/lib/coupons";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getMembershipPerks } from "@/lib/membership";

// Always evaluate fresh — never serve a cached copy. This route mirrors the
// coupon's on/off state in the admin, so disabling a coupon must take the
// banner down immediately (and re-enabling puts it back). The query is a single
// indexed lookup, so there's no need to cache it.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Public: the one active store-wide coupon to advertise on the storefront
// banner. No auth — it only ever exposes an already-public promo code (never
// personal/assigned codes or internal limits).
export async function GET() {
  try {
    // PRICE-05. The featured code must be one THIS viewer can redeem: a
    // members-only code is advertised only to an active member, a
    // non-members-only code only to everyone else. Resolved the way
    // /api/coupons/validate resolves it; a lookup failure reads as non-member,
    // which is the audience the checkout would assume too.
    let isActiveMember = false;
    try {
      const user = await getAuthenticatedUser();
      if (user?.id) isActiveMember = (await getMembershipPerks(user.id)).isActiveMember;
    } catch {
      // Treated as a non-member for the banner; checkout re-checks authoritatively.
    }
    const coupon = await getStorefrontCoupon({ isActiveMember });
    return NextResponse.json(
      { success: true, coupon },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    // Never break the product page over a promo lookup — just show nothing.
    return NextResponse.json({ success: true, coupon: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
