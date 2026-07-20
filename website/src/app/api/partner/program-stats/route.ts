import { NextResponse } from "next/server";
import { getPartnerProgramStats } from "@/lib/partner-portal";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = await getPartnerProgramStats();
    return NextResponse.json({ success: true, stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load partner program stats";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
