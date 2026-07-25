import { NextResponse } from "next/server";
import { getStorefrontCoupon } from "@/lib/coupons";

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
    const coupon = await getStorefrontCoupon();
    return NextResponse.json(
      { success: true, coupon },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    // Never break the product page over a promo lookup — just show nothing.
    return NextResponse.json({ success: true, coupon: null }, { headers: { "Cache-Control": "no-store" } });
  }
}
