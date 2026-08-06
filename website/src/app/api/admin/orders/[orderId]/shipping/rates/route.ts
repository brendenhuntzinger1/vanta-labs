import { NextResponse } from "next/server";

import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { parseAmountToCents } from "@/lib/shippo/client";
import { getRatesForOrder } from "@/lib/shippo/service";
import { httpStatusForShippoError } from "../error-status";

// ---------------------------------------------------------------------------
// GET|POST /api/admin/orders/<orderId>/shipping/rates
//
// Quote what it costs to ship one order. Buys nothing.
//
// ADMIN ONLY, for two reasons that are easy to miss because no money moves: the
// response contains the customer's delivery city/state/ZIP and the store's own
// postage costs, and every call creates a shipment object on the Shippo account
// (an unauthenticated version is a free way to spam Shippo and to enumerate
// where customers live).
//
// Both verbs run the same query. GET is what a dashboard panel naturally calls
// on open; POST exists because quoting genuinely creates a remote resource and
// some clients refuse to send a GET that has side effects. Route Handlers are
// uncached by default in this Next.js version, which is what we want — a cached
// rate list would offer prices that can no longer be bought.
//
// The `id` on each rate is Shippo's rate id. Send it back to the label endpoint
// to buy that exact service; it is remembered server-side (with its price) so
// the postage recorded against the order is never a number that passed through
// a browser.
// ---------------------------------------------------------------------------

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(request, context);
}

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  return handle(request, context);
}

async function handle(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { orderId } = await context.params;

  try {
    const result = await getRatesForOrder(orderId);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.message, code: result.code, detail: result.detail ?? null },
        { status: httpStatusForShippoError(result.code) },
      );
    }

    const { shipmentId, rates, parcel, weightOz, preset } = result.data;

    return NextResponse.json({
      success: true,
      shipmentId,
      // Flattened for the admin picker, with the price in integer cents so the
      // UI never has to parse Shippo's decimal string itself (and never has to
      // multiply a float by 100). The client already dropped anything it could
      // not price, so amountCents is always a real number here.
      rates: rates.map((rate) => ({
        id: rate.object_id,
        carrier: rate.provider,
        service: rate.servicelevel?.name ?? "",
        serviceToken: rate.servicelevel?.token ?? "",
        amountCents: parseAmountToCents(rate.amount),
        currency: rate.currency ?? "USD",
        estimatedDays: typeof rate.estimated_days === "number" ? rate.estimated_days : null,
        durationTerms: rate.duration_terms ?? null,
      })),
      parcel: {
        lengthIn: Number(parcel.length),
        widthIn: Number(parcel.width),
        heightIn: Number(parcel.height),
        weightOz,
      },
      package: preset
        ? { id: preset.id, name: preset.name, emptyWeightOz: preset.emptyWeightOz }
        : null,
    });
  } catch (error) {
    // The service returns typed failures; anything thrown is unexpected and must
    // not leak an internal message to the client.
    console.error("Unable to quote shipping rates for order", orderId, error);
    return NextResponse.json({ success: false, error: "Unable to quote shipping rates." }, { status: 500 });
  }
}
