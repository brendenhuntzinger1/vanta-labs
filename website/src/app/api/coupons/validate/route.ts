import { NextResponse } from "next/server";
import { validateCoupon } from "@/lib/coupons";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  try {
    // Throttle coupon-code guessing: a public validate endpoint with no limit
    // lets an attacker enumerate/brute-force discount codes. 20 attempts / IP
    // per minute is plenty for a real shopper.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const limit = await checkRateLimit(`coupon-validate:${ip}`, 20, 60);
    if (!limit.allowed) {
      const res = NextResponse.json({ success: false, error: "Too many attempts. Please wait a moment." }, { status: 429 });
      res.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return res;
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
