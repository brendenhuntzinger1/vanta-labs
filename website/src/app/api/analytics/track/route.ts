import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

const ALLOWED_EVENTS = new Set([
  "session_start",
  "page_view",
  "add_to_cart",
  "remove_from_cart",
  "update_cart_quantity",
  "begin_checkout",
  "purchase",
]);

function normalizePath(path: unknown) {
  const value = String(path ?? "").trim();
  if (!value) {
    return null;
  }
  if (!value.startsWith("/")) {
    return null;
  }
  return value.slice(0, 500);
}

function normalizeText(value: unknown, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function normalizeIpAddress(headerValue: string | null) {
  if (!headerValue) {
    return null;
  }
  return headerValue.split(",")[0]?.trim().slice(0, 120) || null;
}

const MAX_PAYLOAD_BYTES = 8000;

function normalizePayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return {};
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return {};
    }
    return value as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      eventType?: string;
      pagePath?: string;
      pageUrl?: string;
      referrer?: string;
      sessionId?: string;
      visitorId?: string;
      country?: string;
      city?: string;
      deviceType?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      payload?: Record<string, unknown>;
    };

    const eventType = String(body.eventType ?? "").trim().toLowerCase();
    if (!ALLOWED_EVENTS.has(eventType)) {
      return NextResponse.json({ success: false, error: "Unsupported event type" }, { status: 400 });
    }

    const pagePath = normalizePath(body.pagePath);
    const sessionId = normalizeText(body.sessionId, 120);
    if (!sessionId) {
      return NextResponse.json({ success: false, error: "sessionId is required" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("website_analytics_events")
      .insert({
        event_type: eventType,
        page_path: pagePath,
        page_url: normalizeText(body.pageUrl, 1200),
        referrer: normalizeText(body.referrer, 1200),
        session_id: sessionId,
        visitor_id: normalizeText(body.visitorId, 120),
        user_agent: normalizeText(request.headers.get("user-agent"), 700),
        ip_address: normalizeIpAddress(request.headers.get("x-forwarded-for")),
        country: normalizeText(body.country, 80),
        city: normalizeText(body.city, 120),
        device_type: normalizeText(body.deviceType, 80),
        utm_source: normalizeText(body.utmSource, 120),
        utm_medium: normalizeText(body.utmMedium, 120),
        utm_campaign: normalizeText(body.utmCampaign, 180),
        event_payload: normalizePayload(body.payload),
        created_at: new Date().toISOString(),
      });

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to track event";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}