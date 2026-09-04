import { NextRequest, NextResponse } from "next/server";
import { getAbandonedCartById, liveRecoveryCouponForCart } from "@/lib/cart-recovery";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing cart id" }, { status: 400 });
  }

  let cart;
  try {
    cart = await getAbandonedCartById(id);
  } catch (error) {
    console.error("Unable to restore abandoned cart", error);
    return NextResponse.json({ success: false, error: "This cart link is no longer valid" }, { status: 404 });
  }
  if (!cart || cart.items.length === 0) {
    return NextResponse.json({ success: false, error: "This cart link is no longer valid" }, { status: 404 });
  }

  // The code the cart's own emails promised, armed for the shopper so it is
  // not retyped from the email. Looked up by the cart id only; a code in the
  // URL is never read. Best-effort: a coupon read that fails still restores
  // the cart.
  const coupon = await liveRecoveryCouponForCart(cart.id).catch(() => null);
  return NextResponse.json({
    success: true,
    items: cart.items,
    email: cart.email,
    ...(coupon ? { coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue } } : {}),
  });
}
