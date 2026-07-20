import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { clearFraudFlag, getFraudReviewRows } from "@/lib/admin-ambassadors";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
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
