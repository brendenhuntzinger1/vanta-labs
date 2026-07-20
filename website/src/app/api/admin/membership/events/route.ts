import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { createPromotionalEvent } from "@/lib/admin-membership";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage promotional events." }, { status: 403 });
  }

  try {
    const body = await request.json() as { name?: string; multiplier?: number; startsAt?: string; endsAt?: string };
    const name = String(body.name ?? "").trim();
    const multiplier = Number(body.multiplier ?? 0);
    const startsAt = String(body.startsAt ?? "");
    const endsAt = String(body.endsAt ?? "");

    if (!name || !multiplier || multiplier <= 1 || !startsAt || !endsAt) {
      return NextResponse.json({ success: false, error: "Name, a multiplier greater than 1, and a start/end date are required." }, { status: 400 });
    }

    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      return NextResponse.json({ success: false, error: "Start date must be before end date." }, { status: 400 });
    }

    await createPromotionalEvent({ name, multiplier, startsAt, endsAt });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "membership_promo_event_create",
      target_table: "promotional_point_events",
      target_id: null,
      metadata: {
        name,
        multiplier,
        startsAt,
        endsAt,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create event";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
