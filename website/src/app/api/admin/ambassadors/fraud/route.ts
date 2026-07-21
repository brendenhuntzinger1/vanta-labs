import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { clearFraudFlag, getFraudReviewRows } from "@/lib/admin-ambassadors";

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

  const rows = await getFraudReviewRows();
  return NextResponse.json({ success: true, rows });
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }
  // Clearing a fraud flag releases held commissions for payout - manager+ only.
  if (!canManageRefunds(session.role)) {
    return forbiddenResponse();
  }

  try {
    const body = await request.json();
    const referralOrderId = String(body?.referralOrderId ?? "");

    if (!referralOrderId) {
      return NextResponse.json({ success: false, error: "referralOrderId is required" }, { status: 400 });
    }

    await clearFraudFlag(referralOrderId);
    const rows = await getFraudReviewRows();
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to clear fraud flag";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
