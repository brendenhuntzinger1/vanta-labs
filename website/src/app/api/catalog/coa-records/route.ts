import { NextResponse } from "next/server";
import { getCoaRecords } from "@/lib/catalog";

export async function GET() {
  try {
    const records = await getCoaRecords();
    return NextResponse.json({ success: true, records });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load COA records";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
