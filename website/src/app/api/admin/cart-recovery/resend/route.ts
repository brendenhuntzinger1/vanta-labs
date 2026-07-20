import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCartRecovery } from "@/lib/admin-roles";
import { resendCartRecoveryEmail } from "@/lib/admin-cart-recovery";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageCartRecovery(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage cart recovery." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { cartId?: string; stage?: string } | null;
  if (!body?.cartId || !["t30m", "t12h", "t24h", "t72h"].includes(body.stage ?? "")) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await resendCartRecoveryEmail(body.cartId, body.stage as "t30m" | "t12h" | "t24h" | "t72h");

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "cart_recovery_manual_resend",
      target_table: "abandoned_carts",
      target_id: body.cartId,
      metadata: {
        stage: body.stage,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: result.success, error: result.error });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resend this email";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
