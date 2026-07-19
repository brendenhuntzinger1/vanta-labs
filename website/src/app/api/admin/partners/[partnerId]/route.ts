import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { markCommissionsPaid, updatePartnerStatus } from "@/lib/partner-portal";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ partnerId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const { partnerId } = await context.params;

  try {
    const body = await request.json();
    const action = String(body?.action ?? "");

    if (action === "set_status") {
      const status = body?.status as "approved" | "disabled" | "pending" | "rejected";
      const commissionPercent = body?.commissionPercent !== undefined ? Number(body.commissionPercent) : undefined;

      if (!["approved", "disabled", "pending", "rejected"].includes(status)) {
        return NextResponse.json({ success: false, error: "Invalid status" }, { status: 400 });
      }

      await updatePartnerStatus({
        partnerId,
        status,
        actorUserId: undefined,
        commissionPercent,
      });

      return NextResponse.json({ success: true });
    }

    if (action === "mark_paid") {
      const amount = Number(body?.amount ?? 0);
      const note = typeof body?.note === "string" ? body.note : undefined;

      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ success: false, error: "Amount must be greater than 0" }, { status: 400 });
      }

      const payout = await markCommissionsPaid({
        partnerId,
        actorUserId: undefined,
        amount,
        note,
      });

      return NextResponse.json({ success: true, payout });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update partner";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
