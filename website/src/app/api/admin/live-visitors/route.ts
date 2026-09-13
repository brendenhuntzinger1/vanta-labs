import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getLiveVisitors } from "@/lib/admin-live-visitors";
import { customerSafeMessage } from "@/lib/safe-error";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const visitors = await getLiveVisitors();
    return NextResponse.json({ success: true, visitors });
  } catch (error) {
    console.error("[admin/live-visitors]", error);
    const message = customerSafeMessage(error, "Unable to load live visitors");
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
