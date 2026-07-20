import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { deleteCommissionTierRule, listCommissionTierRules, updateCommissionTierRule } from "@/lib/ambassador-commission";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ tierId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const { tierId } = await context.params;

  try {
    const body = await request.json();
    const update: Parameters<typeof updateCommissionTierRule>[1] = {};

    if (body?.name !== undefined) update.name = String(body.name);
    if (body?.minMonthlySales !== undefined) update.minMonthlySales = Number(body.minMonthlySales);
    if (body?.commissionPercent !== undefined) update.commissionPercent = Number(body.commissionPercent);
    if (body?.position !== undefined) update.position = Number(body.position);
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
