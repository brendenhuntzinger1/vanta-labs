import { NextResponse } from "next/server";
import { getBulkSavingsControlConfig } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await getBulkSavingsControlConfig();
  return NextResponse.json({ success: true, config });
}
