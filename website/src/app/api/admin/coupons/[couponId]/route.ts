import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoupons } from "@/lib/admin-roles";
import { deleteAdminCoupon, updateAdminCoupon, type CouponInput } from "@/lib/admin-coupons";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage coupons." }, { status: 403 });
}

export async function PATCH(request: Request, context: { params: Promise<{ couponId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageCoupons(session.role)) {
    return forbiddenResponse();
  }

  const { couponId } = await context.params;

  try {
    const body = await request.json() as Partial<CouponInput>;
    const coupon = await updateAdminCoupon(couponId, body);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "coupon_update",
      target_table: "coupons",
      target_id: couponId,
      metadata: {
        changes: body,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true, coupon });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update coupon";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ couponId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageCoupons(session.role)) {
    return forbiddenResponse();
  }

  const { couponId } = await context.params;

  try {
    await deleteAdminCoupon(couponId);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "coupon_delete",
      target_table: "coupons",
      target_id: couponId,
      metadata: {
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete coupon";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
