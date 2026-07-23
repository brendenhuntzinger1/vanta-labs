import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoupons } from "@/lib/admin-roles";
import { createAdminCoupon, listAdminCoupons, type CouponInput } from "@/lib/admin-coupons";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage coupons." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  // Discount codes are sensitive (a leaked list enables free-order abuse); gate
  // reads to the same bar as coupon writes.
  if (!canManageCoupons(session.role)) {
    return forbiddenResponse();
  }

  try {
    const coupons = await listAdminCoupons();
    return NextResponse.json({ success: true, coupons });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load coupons";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageCoupons(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json() as CouponInput;
    const coupon = await createAdminCoupon(body);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "coupon_create",
      target_table: "coupons",
      target_id: coupon.id,
      metadata: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true, coupon });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create coupon";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
