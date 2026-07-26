import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { deleteCommissionTierRule, listCommissionTierRules, updateCommissionTierRule } from "@/lib/ambassador-commission";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ success: false, error: "Your role does not have permission to manage the ambassador program." }, { status: 403 });
}

export async function PATCH(request: Request, context: { params: Promise<{ tierId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageRefunds(session.role)) {
    return forbiddenResponse();
  }

  const { tierId } = await context.params;

  try {
    const body = await request.json();
    const update: Parameters<typeof updateCommissionTierRule>[1] = {};

    // Validate numeric fields (finite + in range) BEFORE they reach payout
    // math — mirrors the POST create-tier and per-partner endpoints, which both
    // reject non-finite/out-of-range. Without this a manager could PATCH a tier
    // to a 99% (or NaN) commission that flows straight into commission payouts.
    if (body?.name !== undefined) update.name = String(body.name);
    if (body?.minMonthlySales !== undefined) {
      const v = Number(body.minMonthlySales);
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json({ success: false, error: "Minimum monthly orders must be a non-negative number." }, { status: 400 });
      }
      update.minMonthlySales = v;
    }
    if (body?.commissionPercent !== undefined) {
      const v = Number(body.commissionPercent);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return NextResponse.json({ success: false, error: "Commission percent must be a number between 0 and 100." }, { status: 400 });
      }
      update.commissionPercent = v;
    }
    if (body?.position !== undefined) {
      const v = Number(body.position);
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json({ success: false, error: "Position must be a non-negative number." }, { status: 400 });
      }
      update.position = v;
    }
    if (body?.isActive !== undefined) update.isActive = Boolean(body.isActive);

    await updateCommissionTierRule(tierId, update);
    const tiers = await listCommissionTierRules();
    return NextResponse.json({ success: true, tiers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update commission tier";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ tierId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageRefunds(session.role)) {
    return forbiddenResponse();
  }

  const { tierId } = await context.params;

  try {
    await deleteCommissionTierRule(tierId);
    const tiers = await listCommissionTierRules();
    return NextResponse.json({ success: true, tiers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete commission tier";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
