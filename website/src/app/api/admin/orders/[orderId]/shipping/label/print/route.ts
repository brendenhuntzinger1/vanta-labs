import { NextResponse } from "next/server";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { getLabelUrlForOrder } from "@/lib/shippo/service";
import { httpStatusForShippoError } from "../../error-status";

// ---------------------------------------------------------------------------
// GET /api/admin/orders/<orderId>/shipping/label/print
//
// Streams the already-purchased label PDF to the admin. Never talks to Shippo's
// purchase API: reprinting is a printing problem, and a second call to
// /transactions/ would be a second charge.
//
// Why proxy instead of returning Shippo's URL: that URL is an unauthenticated
// link to a document carrying the customer's full name and home address.
// Handing it to the browser puts it in history, in the Referer of anything the
// page then loads, and in any screenshot of the dashboard. Streaming it through
// this handler means the label is only readable by someone holding an admin
// session cookie, and it stops being readable the moment that session is
// revoked.
//
// `?download=1` returns it as an attachment; the default is inline so the
// browser print dialog can send it straight to the 4x6 thermal printer.
// ---------------------------------------------------------------------------

/** A hung label host must not hold an admin request open indefinitely. */
const LABEL_FETCH_TIMEOUT_MS = 15_000;

/**
 * Only fetch from hosts Shippo actually serves labels from.
 *
 * `orders.label_url` is written by our own purchase code, so this is defence in
 * depth rather than a live threat — but it is the difference between a corrupted
 * or tampered row being a broken link and it being a server-side request forgery
 * primitive aimed at the cloud metadata endpoint.
 */
function isAllowedLabelHost(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "goshippo.com" || host.endsWith(".goshippo.com")) return true;
  if (host === "shippo.com" || host.endsWith(".shippo.com")) return true;
  // Shippo serves the generated PDFs from its own S3 buckets.
  return /^shippo-delivery[a-z0-9.-]*\.s3[a-z0-9.-]*\.amazonaws\.com$/.test(host);
}

/** Filename-safe order reference: no path separators, no quotes, no spaces. */
function safeFilename(reference: string): string {
  const cleaned = reference.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60);
  return `label-${cleaned || "order"}.pdf`;
}

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  let result;
  try {
    result = await getLabelUrlForOrder(orderId);
  } catch (error) {
    console.error("Unable to load the shipping label for order", orderId, error);
    return NextResponse.json({ success: false, error: "Unable to load this label." }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.message, code: result.code },
      { status: httpStatusForShippoError(result.code) },
    );
  }

  const storedUrl = result.data.labelUrl ?? "";
  let labelUrl: URL;
  try {
    labelUrl = new URL(storedUrl);
  } catch {
    return NextResponse.json({ success: false, error: "This order's label link is unreadable." }, { status: 502 });
  }

  if (!isAllowedLabelHost(labelUrl)) {
    // Deliberately does not echo the URL back to the client.
    console.error("Refusing to fetch a label from an unexpected host for order", orderId, labelUrl.hostname);
    return NextResponse.json(
      { success: false, error: "This order's label link does not point at Shippo." },
      { status: 502 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(labelUrl, {
      // Next.js extends fetch with a persistent cache; a label is customer data
      // and has no business in a shared cache.
      cache: "no-store",
      signal: AbortSignal.timeout(LABEL_FETCH_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json(
      { success: false, error: "Could not reach Shippo to fetch the label. Try again in a moment." },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { success: false, error: "Shippo could not return this label right now." },
      { status: 502 },
    );
  }

  const download = new URL(request.url).searchParams.get("download") === "1";

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safeFilename(result.data.orderNumber || result.data.orderId)}"`,
      // No proxy, browser or CDN may keep a copy of a document with the
      // customer's address on it.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
