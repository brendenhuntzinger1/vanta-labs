import { NextResponse } from "next/server";
import { validateCoupon } from "@/lib/coupons";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { checkRateLimit, rateLimitedResponseBody } from "@/lib/rate-limit";

function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: Request) {
  try {
    // Throttle to prevent coupon-code enumeration.
    const rl = await checkRateLimit({ action: "coupon_validate", identifier: clientIp(request), limit: 20, windowSeconds: 60 });
    if (!rl.allowed) {
      return NextResponse.json(rateLimitedResponseBody(), { status: 429 });
    }

    const body = await request.json() as { code?: string; subtotal?: number };
    const code = String(body.code ?? "").slice(0, 40);
    const subtotal = Number(body.subtotal ?? 0);

    if (!code.trim()) {
      return NextResponse.json({ success: false, error: "Enter a coupon code." }, { status: 400 });
    }

    // Pass the signed-in shopper's email so a once-per-customer welcome offer is
    // rejected here in the cart, not just silently later at payment time.
    const user = await getAuthenticatedUser();
    const coupon = await validateCoupon(code, Number.isFinite(subtotal) ? subtotal : 0, user?.email ?? undefined);

    if (!coupon) {
      return NextResponse.json({ success: false, error: "Enter a coupon code." }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount: coupon.discountAmount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify coupon code";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
