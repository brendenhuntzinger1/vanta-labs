import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { batchLabelUrls } from "@/lib/fulfillment-labels";

// ---------------------------------------------------------------------------
// GET /api/admin/fulfillment/labels/print?batchId=…
//
// Every purchased label in a batch, merged into ONE 4x6 PDF, in the SAME order
// the packing bench serves them. One request, one document, one print job, one
// Zebra queue — instead of ninety-five tabs and ninety-five dialogs.
//
// READS STORED LABELS ONLY. It never calls Shippo's transaction API, so
// printing and reprinting are free and can never buy postage. Voided labels are
// excluded upstream in batchLabelUrls().
//
// The same protections as the single-label route apply and for the same
// reasons: a label carries the customer's full name and home address, so the
// document is streamed through this admin-authenticated handler rather than
// handing the browser an unauthenticated Shippo URL that would land in history,
// in a Referer header and in any screenshot.
// ---------------------------------------------------------------------------

const LABEL_FETCH_TIMEOUT_MS = 15_000;

/** Only fetch from hosts Shippo actually serves labels from. */
function isAllowedLabelHost(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "goshippo.com" || host.endsWith(".goshippo.com")) return true;
  if (host === "shippo-delivery.s3.amazonaws.com") return true;
  if (host === "shippo-delivery-east.s3.amazonaws.com") return true;
  return false;
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const batchId = new URL(request.url).searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ success: false, error: "A batchId is required." }, { status: 400 });
  }

  let labels;
  try {
    labels = await batchLabelUrls(batchId);
  } catch (error) {
    console.error("Unable to list batch labels", batchId, error);
    return NextResponse.json({ success: false, error: "Unable to list this batch's labels." }, { status: 500 });
  }

  if (labels.length === 0) {
    return NextResponse.json(
      { success: false, error: "No purchased labels in this batch yet." },
      { status: 404 },
    );
  }

  const merged = await PDFDocument.create();
  const skipped: string[] = [];

  // Sequential, preserving packing order exactly. Concurrency here would risk
  // reordering the pages, and a label sheet out of step with the packing queue
  // is how the wrong label goes on the wrong parcel.
  for (const label of labels) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(label.labelUrl);
    } catch {
      skipped.push(label.orderId);
      continue;
    }
    if (!isAllowedLabelHost(parsedUrl)) {
      skipped.push(label.orderId);
      continue;
    }

    try {
      const response = await fetch(parsedUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(LABEL_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        skipped.push(label.orderId);
        continue;
      }
      const bytes = await response.arrayBuffer();
      const source = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } catch (error) {
      // One unreachable label must not cost the operator the other ninety-four.
      console.error("Skipped a label while merging batch", batchId, label.orderId, error);
      skipped.push(label.orderId);
    }
  }

  if (merged.getPageCount() === 0) {
    return NextResponse.json(
      { success: false, error: "None of this batch's labels could be fetched." },
      { status: 502 },
    );
  }

  const bytes = await merged.save();

  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // Inline so the browser print dialog opens straight onto the 4x6 printer.
      "Content-Disposition": `inline; filename="batch-${batchId}-labels.pdf"`,
      // A label sheet must never be cached — a reprint after a void would
      // otherwise hand back a document the carrier has been told to expect.
      "Cache-Control": "no-store, max-age=0",
      // Tells the UI when the sheet is short, so the operator is never left
      // believing they printed more labels than actually merged.
      "X-Labels-Merged": String(labels.length - skipped.length),
      "X-Labels-Skipped": String(skipped.length),
    },
  });
}
