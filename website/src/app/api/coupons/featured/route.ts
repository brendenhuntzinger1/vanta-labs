import { NextResponse } from "next/server";
import { getStorefrontCoupon } from "@/lib/coupons";

// Public: the one active store-wide coupon to advertise on the storefront
// banner. No auth — it only ever exposes an already-public promo code (never
// personal/assigned codes or internal limits). Lightly cached so a burst of
// product-page views doesn't hammer the DB; a newly toggled coupon still shows
// within a minute.
export async function GET() {
  try {
    const coupon = await getStorefrontCoupon();
    return NextResponse.json(
      { success: true, coupon },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } },
    );
  } catch {
    // Never break the product page over a promo lookup — just show nothing.
    return NextResponse.json({ success: true, coupon: null });
  }
}
