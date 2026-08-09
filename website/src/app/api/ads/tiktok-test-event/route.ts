import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import {
  buildEventsApiPayload,
  credentialStatus,
  describeResult,
  sendServerEvents,
  assertNoSecret,
  EVENT_TIME_FORMAT,
  PIXEL_ID,
} from "@/lib/ads/tiktok-events-api";

/**
 * Diagnostic: send one real server event to TikTok and report exactly what
 * they said back.
 *
 * Admin-only. It reaches an external API with the account's credentials, so it
 * is not something an anonymous request should be able to trigger.
 *
 * The point of this route is that no amount of code review can tell you whether
 * TikTok accepts a payload — only TikTok can. It returns their `code`,
 * `message` and `request_id` verbatim, which is what resolves the one genuine
 * ambiguity in the implementation (whether `event_time` should be an epoch or
 * an ISO string) and what TikTok support asks for if anything else is wrong.
 *
 * Nothing sensitive travels back: the response carries the outgoing payload
 * with identifiers already hashed, never the access token, and the payload is
 * checked for the token before it is returned.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    return NextResponse.json({ error: "admin session required" }, { status: 401 });
  }

  const credentials = credentialStatus();
  if (!credentials.configured) {
    return NextResponse.json(
      {
        sent: false,
        reason: "credentials not configured",
        missing: credentials.missing,
        hint: "Set TIKTOK_EVENTS_API_ACCESS_TOKEN in Vercel and redeploy. It is read server-side only.",
      },
      { status: 200 },
    );
  }

  let body: { testEventCode?: string; email?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    /* an empty body is fine */
  }

  const testEventCode = String(body.testEventCode ?? "").trim();
  if (!testEventCode) {
    return NextResponse.json(
      {
        sent: false,
        reason: "testEventCode is required",
        hint:
          "Events Manager → your pixel → Test Events shows a code like TEST12345. Without it this would " +
          "post a fabricated Purchase into production reporting, which is the one thing a diagnostic must never do.",
      },
      { status: 400 },
    );
  }

  // A clearly-marked probe. The value is deliberately trivial and the order id
  // is obviously synthetic, so that if it ever escaped into production
  // reporting it would be recognisable at a glance rather than blending in
  // with real revenue.
  const eventId = `diagnostic-${Date.now()}`;
  const event = {
    event: "Purchase" as const,
    eventId,
    occurredAt: new Date(),
    user: {
      email: body.email?.trim() || "diagnostic@vantalabsresearch.com",
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    },
    properties: {
      contents: [{ content_id: "diagnostic-probe", content_type: "product" as const, content_name: "Diagnostic probe", quantity: 1, price: 1 }],
      currency: "USD",
      value: 1,
      order_id: `DIAGNOSTIC-${eventId}`,
    },
    pageUrl: "https://vantalabsresearch.com/diagnostic",
  };

  const outcome = await sendServerEvents([event], { testEventCode });

  // The payload is echoed so a rejection can be diagnosed without a second
  // round trip. Identifiers inside it are already hashed by the builder.
  const payload = buildEventsApiPayload([event], { testEventCode });
  const serialised = JSON.stringify(payload);
  assertNoSecret(serialised);

  return NextResponse.json(
    {
      sent: true,
      delivered: outcome.delivered,
      summary: describeResult(outcome),
      tiktok: {
        code: outcome.tiktokCode,
        message: outcome.tiktokMessage,
        requestId: outcome.requestId,
        httpStatus: outcome.httpStatus,
      },
      transportError: outcome.transportError,
      durationMs: outcome.durationMs,
      config: { pixelId: PIXEL_ID, eventTimeFormat: EVENT_TIME_FORMAT, testEventCode },
      payloadSent: payload,
      nextStep: outcome.delivered
        ? "Open Events Manager → your pixel → Test Events. The event should appear within about a minute."
        : "Not delivered. Read tiktok.code and tiktok.message above — that is TikTok's own reason, not a guess.",
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
