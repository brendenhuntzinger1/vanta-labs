import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCoupons } from "@/lib/admin-roles";
import { listAdminCoupons } from "@/lib/admin-coupons";
import { broadcastCouponAnnouncement } from "@/lib/marketing-broadcast";
import { getEmailRuntimeConfig, emailConfigIsReady } from "@/lib/email/settings";
import { supabaseAdmin } from "@/lib/supabase-server";

// Emails every opted-in customer a one-off announcement for this coupon.
export async function POST(request: Request, context: { params: Promise<{ couponId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageCoupons(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage coupons." }, { status: 403 });
  }

  // Fail clearly instead of silently no-op'ing if email isn't set up yet.
  const emailConfig = await getEmailRuntimeConfig();
  if (!emailConfigIsReady(emailConfig)) {
    return NextResponse.json(
      { success: false, error: "Email isn't set up yet. Configure it under Settings → Transactional Email, then try again." },
      { status: 400 },
    );
  }

  const { couponId } = await context.params;

  try {
    const body = await request.json().catch(() => ({}));
    const headlineRaw = typeof body?.headline === "string" ? body.headline.trim() : "";
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, 400) : undefined;

    const coupons = await listAdminCoupons();
    const coupon = coupons.find((c) => c.id === couponId);
    if (!coupon) {
      return NextResponse.json({ success: false, error: "Coupon not found" }, { status: 404 });
    }

    const headline = (headlineRaw || `New offer: ${coupon.code}`).slice(0, 120);

    const result = await broadcastCouponAnnouncement({ coupon, headline, message });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "coupon_announced",
      target_table: "coupons",
      target_id: couponId,
      metadata: {
        ...result,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send announcement";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
