import { NextResponse } from "next/server";
import { getPartnerProgramStats } from "@/lib/partner-portal";
import { customerSafeMessage } from "@/lib/safe-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = await getPartnerProgramStats();
    return NextResponse.json({ success: true, stats });
  } catch (error) {
    const message = customerSafeMessage(error, "Unable to load partner program stats");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
