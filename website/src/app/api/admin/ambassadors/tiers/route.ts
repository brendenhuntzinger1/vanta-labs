import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { createCommissionTierRule, listCommissionTierRules } from "@/lib/ambassador-commission";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage the ambassador program." }, { status: 403 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const tiers = await listCommissionTierRules();
  return NextResponse.json({ success: true, tiers });
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  // Commission tiers set the percentages that determine partner payouts, so
  // creating them is gated to manager+ (same bar as per-partner changes).
  if (!canManageRefunds(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json();
    const name = String(body?.name ?? "").trim();
    const minMonthlySales = Number(body?.minMonthlySales ?? 0);
    const commissionPercent = Number(body?.commissionPercent ?? 0);
    const position = Number(body?.position ?? 0);

    if (!name) {
      return NextResponse.json({ success: false, error: "Name is required" }, { status: 400 });
    }

    if (!Number.isFinite(minMonthlySales) || minMonthlySales < 0) {
      return NextResponse.json({ success: false, error: "Minimum monthly sales must be a non-negative number" }, { status: 400 });
    }

    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      return NextResponse.json({ success: false, error: "Commission percent must be between 0 and 100" }, { status: 400 });
    }

    await createCommissionTierRule({ name, minMonthlySales, commissionPercent, position });
    const tiers = await listCommissionTierRules();
    return NextResponse.json({ success: true, tiers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create commission tier";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
