import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "crypto";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { upsertControlValue } from "@/lib/admin-control";
import { getFulfillmentRuntimeConfig } from "@/lib/fulfillment/config";
import { getFulfillmentProvider, type NormalizedFulfillmentOrder } from "@/lib/fulfillment/provider";
import { getSiteUrl } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}
function forbidden() {
  return NextResponse.json({ success: false, error: "Your role does not have permission for this." }, { status: 403 });
}

// A clearly-fake sample order used for the "send test order" connectivity
// check. `test: true` and the TEST- reference make it obvious to the 3PL that
// this is not a real shipment.
function sampleOrder(): NormalizedFulfillmentOrder {
  return {
    orderId: "TEST-CONNECTION",
    orderNumber: "TEST-CONNECTION",
    customer: { name: "Connection Test", email: "test@example.com" },
    shipping: { address: "123 Test St", city: "Testville", postalCode: "00000", country: "US" },
    items: [{ sku: "test-sku", variant: null, name: "Connectivity Test Item", quantity: 1, unitPrice: 0 }],
    notes: "This is an automated connectivity test from Vanta Labs. Please ignore or cancel — do not ship.",
    totals: { subtotal: 0, shipping: 0, tax: 0, total: 0 },
  };
}

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return unauthorized();
  if (!canManageSettings(session.role)) return forbidden();

  const meta = {
    actorUsername: session.username,
    ipAddress: getRequestIpAddress(request),
    userAgent: getRequestUserAgent(request),
  };

  let action = "";
  try {
    const body = (await request.json()) as { action?: string };
    action = String(body.action ?? "");
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const webhookUrl = `${getSiteUrl()}/api/webhooks/fulfillment`;

  try {
    // ------------------------------------------------------------------
    // Generate + save a strong inbound webhook secret. Returned in plaintext
    // ONCE so the operator can copy it and share it with the 3PL; afterwards
    // it is only ever stored (and shown masked).
    // ------------------------------------------------------------------
    if (action === "generate_secret") {
      const secret = randomBytes(32).toString("hex");
      await upsertControlValue({ section: "fulfillment", key: "webhook_secret", value: secret, ...meta });
      return NextResponse.json({ success: true, secret, webhookUrl });
    }

    // ------------------------------------------------------------------
    // The SKU list to hand to the 3PL. These are the product slugs the store
    // sends on every order and matches on for inventory sync.
    // ------------------------------------------------------------------
    if (action === "sku_list") {
      const { data, error } = await supabaseAdmin
        .from("products")
        .select("slug, name, inventory_quantity")
        .eq("is_enabled", true)
        .order("name", { ascending: true });
      if (error) throw error;
      const skus = (data ?? []).map((row) => ({
        sku: String(row.slug),
        name: String(row.name ?? ""),
        stock: Number(row.inventory_quantity ?? 0),
      }));
      return NextResponse.json({ success: true, skus });
    }

    // ------------------------------------------------------------------
    // Outbound connectivity test: POST a clearly-marked sample order to the
    // configured 3PL API and report exactly what came back.
    // ------------------------------------------------------------------
    if (action === "test_connection") {
      const config = await getFulfillmentRuntimeConfig();
      if (config.mode !== "generic_rest") {
        return NextResponse.json({ success: false, error: "Set mode to “Generic REST” and save your 3PL API URL + key first." });
      }
      if (!config.apiBaseUrl || !config.apiKey) {
        return NextResponse.json({ success: false, error: "Enter and save the 3PL API base URL and API key first." });
      }
      const provider = getFulfillmentProvider(config);
      const result = await provider.createFulfillmentOrder(sampleOrder());
      return NextResponse.json({
        success: result.ok,
        outbound: {
          reached: result.status !== "error" || result.statusCode !== undefined,
          status: result.status,
          statusCode: result.statusCode ?? null,
          message: result.message ?? (result.ok ? "3PL accepted the test order." : "No response."),
          externalId: result.externalId ?? null,
        },
      });
    }

    // ------------------------------------------------------------------
    // Inbound self-test: build a harmless inventory event, sign it with the
    // saved secret exactly as a real 3PL would, and POST it to our own public
    // webhook. This proves the signature check + endpoint work end-to-end with
    // ZERO side effects (the SKU is fake, so no real product/order changes).
    // ------------------------------------------------------------------
    if (action === "self_test_webhook") {
      const config = await getFulfillmentRuntimeConfig();
      if (!config.enabled) {
        return NextResponse.json({ success: false, error: "Turn on “Enable fulfillment” and save before testing." });
      }
      if (!config.webhookSecret) {
        return NextResponse.json({ success: false, error: "Generate or save an inbound webhook secret first." });
      }
      const payload = JSON.stringify({
        type: "inventory",
        inventory: [{ sku: "__vanta_selftest__", quantity: 0 }],
      });
      const signature = "sha256=" + createHmac("sha256", config.webhookSecret).update(payload, "utf8").digest("hex");
      let inbound: { ok: boolean; status: number; message: string };
      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-fulfillment-signature": signature },
          body: payload,
        });
        const json = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; error?: string };
        inbound = {
          ok: res.ok && json.success === true,
          status: res.status,
          message: json.message ?? json.error ?? `HTTP ${res.status}`,
        };
      } catch (error) {
        inbound = { ok: false, status: 0, message: error instanceof Error ? error.message : "Request failed" };
      }
      return NextResponse.json({ success: inbound.ok, inbound });
    }

    return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onboarding action failed.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
