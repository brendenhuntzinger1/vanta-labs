import { NextRequest, NextResponse } from "next/server";
import { getCoaRecordByBatch } from "@/lib/catalog";
import { generateCoaQrSvg } from "@/lib/qr-code";
import { getSiteUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

// Returns a downloadable SVG QR code that points at the public verification
// page for a given batch (`/coa/[batch]`). Print this on the vial label or
// packaging insert: scanning it takes a buyer to the verified batch page and
// the original third-party lab report. Only real, published batches resolve.
export async function GET(request: NextRequest) {
  const batch = request.nextUrl.searchParams.get("batch")?.trim() ?? "";
  if (!batch) {
    return NextResponse.json({ success: false, error: "Missing batch" }, { status: 400 });
  }

  const record = await getCoaRecordByBatch(batch).catch(() => null);
  if (!record) {
    return NextResponse.json({ success: false, error: "Unknown batch" }, { status: 404 });
  }

  const verifyUrl = `${getSiteUrl().replace(/\/+$/, "")}/coa/${encodeURIComponent(record.batchNumber)}`;
  const svg = await generateCoaQrSvg(verifyUrl);
  const filename = `coa-${record.batchNumber.replace(/[^a-zA-Z0-9._-]/g, "-")}.svg`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
