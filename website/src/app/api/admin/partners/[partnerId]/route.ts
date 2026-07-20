import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { markCommissionsPaid, updatePartnerStatus } from "@/lib/partner-portal";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
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
      const amount = Number(body?.amount ?? 0);
      const note = typeof body?.note === "string" ? body.note : undefined;
      const overrideMinimumThreshold = body?.overrideMinimumThreshold === true;

      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ success: false, error: "Amount must be greater than 0" }, { status: 400 });
      }

      const payout = await markCommissionsPaid({
        partnerId,
        actorUserId: undefined,
        amount,
        note,
        actorUsername: session.username,
        ipAddress,
        userAgent,
        overrideMinimumThreshold,
      });

      return NextResponse.json({ success: true, payout });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update partner";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
