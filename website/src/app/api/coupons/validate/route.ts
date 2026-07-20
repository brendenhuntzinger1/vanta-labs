import { NextResponse } from "next/server";
import { validateCoupon } from "@/lib/coupons";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { code?: string; subtotal?: number };
    const code = String(body.code ?? "").slice(0, 40);
    const subtotal = Number(body.subtotal ?? 0);

    if (!code.trim()) {
      return NextResponse.json({ success: false, error: "Enter a coupon code." }, { status: 400 });
    }

    const coupon = await validateCoupon(code, Number.isFinite(subtotal) ? subtotal : 0);

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
