import { NextResponse } from "next/server";
import { getBulkSavingsControlConfig } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await getBulkSavingsControlConfig();
    return NextResponse.json({ success: true, config });
  } catch (error) {
    // Never hard-fail a product page over a bulk-savings config read.
    console.error("Unable to load bulk-savings config", error);
    return NextResponse.json({ success: false, config: null });
  }
}
