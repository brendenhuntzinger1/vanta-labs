import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCartRecovery } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageCartRecovery(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage cart recovery." }, { status: 403 });
  }

  try {
    const body = await request.json() as Record<string, unknown>;
    const ipAddress = getRequestIpAddress(request);
    const userAgent = getRequestUserAgent(request);

    const entries: Array<[string, unknown]> = [
      ["t30m_enabled", body.t30mEnabled],
      ["t12h_enabled", body.t12hEnabled],
      ["t24h_enabled", body.t24hEnabled],
      ["t72h_enabled", body.t72hEnabled],
      ["discount_percent", body.discountPercent],
      ["coupon_expiration_hours", body.couponExpirationHours],
    ];

    for (const [key, value] of entries) {
      if (value === undefined) continue;
      await upsertControlValue({
        section: "cart_recovery",
        key,
        value,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save cart recovery settings";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
