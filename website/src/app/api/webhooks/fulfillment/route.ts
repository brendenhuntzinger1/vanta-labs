import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { getFulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import { applyInboundFulfillmentEvent, type InboundFulfillmentEvent } from "@/lib/fulfillment/service";

export const dynamic = "force-dynamic";

function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!payload || !signature || !secret) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  let a: Buffer;
  try {
    a = Buffer.from(provided, "hex");
  } catch {
    return false;
  }
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Maps a variety of common 3PL webhook shapes into our normalized event. A
// genuinely non-standard provider can get its own mapping here without
// touching the rest of the system.
function normalizeInbound(body: Record<string, unknown>): InboundFulfillmentEvent {
  const rawType = (str(body.type) || str(body.event) || "status").toLowerCase();
  let type: InboundFulfillmentEvent["type"] = "status";
  if (rawType.includes("inventory")) type = "inventory";
  else if (rawType.includes("cancel")) type = "cancelled";
  else if (rawType.includes("refund")) type = "refund";
  else if (rawType.includes("error")) type = "error";
  else if (rawType.includes("track")) type = "tracking";

  const inventoryRaw = Array.isArray(body.inventory) ? (body.inventory as Array<Record<string, unknown>>) : [];

  return {
    type,
    orderRef: str(body.reference) || str(body.order_id) || str(body.order_number) || undefined,
    externalId: str(body.id) || str(body.external_id) || undefined,
    status: str(body.status) || undefined,
    trackingNumber: str(body.tracking_number) || str(body.tracking) || undefined,
    trackingUrl: str(body.tracking_url) || undefined,
    carrier: str(body.carrier) || undefined,
    message: str(body.message) || str(body.error) || undefined,
    inventory: inventoryRaw
      .map((row) => ({ sku: str(row.sku), quantity: Number(row.quantity ?? 0) }))
      .filter((row) => row.sku),
  };
}

export async function POST(request: Request) {
  try {
    const config = await getFulfillmentRuntimeConfig();
    if (!config.enabled) {
      return NextResponse.json({ success: false, error: "Fulfillment integration is disabled." }, { status: 400 });
    }
    if (!config.webhookSecret) {
      return NextResponse.json({ success: false, error: "Fulfillment webhook secret is not configured." }, { status: 400 });
    }

    const payload = await request.text();
    const signature = request.headers.get("x-fulfillment-signature") ?? "";
    if (!verifySignature(payload, signature, config.webhookSecret)) {
      return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 401 });
    }

    const body = JSON.parse(payload) as Record<string, unknown>;
    const event = normalizeInbound(body);
    const result = await applyInboundFulfillmentEvent(event);

    return NextResponse.json({ success: result.ok, message: result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook failed";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
