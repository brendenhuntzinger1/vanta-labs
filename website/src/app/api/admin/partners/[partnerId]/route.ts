import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { deleteAmbassador, markCommissionsPaid, updatePartnerStatus } from "@/lib/partner-portal";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  // Partner approval, commission-rate changes, and marking commissions paid
  // all move real money, so they are gated to manager+ (same bar as refunds).
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage partners." }, { status: 403 });
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  const { partnerId } = await context.params;

  try {
    const body = await request.json();
    const action = String(body?.action ?? "");

    if (action === "set_status") {
      const status = body?.status as "approved" | "disabled" | "pending" | "rejected" | "info_requested";
      const commissionPercent = body?.commissionPercent !== undefined ? Number(body.commissionPercent) : undefined;
      const commissionPercentLocked = typeof body?.commissionPercentLocked === "boolean" ? body.commissionPercentLocked : undefined;
      const referralCode = typeof body?.referralCode === "string" ? body.referralCode : undefined;

      if (!["approved", "disabled", "pending", "rejected", "info_requested"].includes(status)) {
        return NextResponse.json({ success: false, error: "Invalid status" }, { status: 400 });
      }

      await updatePartnerStatus({
        partnerId,
        status,
        actorUserId: undefined,
        commissionPercent,
        commissionPercentLocked,
        referralCode,
        actorUsername: session.username,
        ipAddress,
        userAgent,
      });

      return NextResponse.json({ success: true });
    }

    if (action === "mark_paid") {
      // The payout amount is computed server-side from the ambassador's actual
      // approved commissions (see markCommissionsPaid). Any client-supplied
      // amount is ignored to prevent under/over-payment.
      const note = typeof body?.note === "string" ? body.note : undefined;
      const overrideMinimumThreshold = body?.overrideMinimumThreshold === true;

      const payout = await markCommissionsPaid({
        partnerId,
        actorUserId: undefined,
        amount: Number(body?.amount ?? 0),
        note,
        actorUsername: session.username,
        ipAddress,
        userAgent,
        overrideMinimumThreshold,
      });

      if (!payout.payoutId) {
        return NextResponse.json(
          { success: false, error: "No approved commissions are pending payout for this ambassador." },
          { status: 400 },
        );
      }

      return NextResponse.json({ success: true, payout });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update partner";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage partners." }, { status: 403 });
  }

  const { partnerId } = await context.params;

  try {
    await deleteAmbassador({
      partnerId,
      actorUsername: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to remove ambassador";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
