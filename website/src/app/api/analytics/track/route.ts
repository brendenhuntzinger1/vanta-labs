import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { createOptionalColumnInserter } from "@/lib/analytics-column-fallback";
import { customerSafeMessage } from "@/lib/safe-error";
import { normalizeCampaignTag } from "@/lib/attribution";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { resolveAnalyticsUserId } from "@/lib/analytics-identity";
import { resolveCoarseGeoFromHeaders } from "@/lib/request-geo";
import { isLikelyBotUserAgent } from "@/lib/bot-detection";

const insertAnalyticsEvent = createOptionalColumnInserter(async (row) =>
  supabaseAdmin.from("website_analytics_events").insert(row),
);

// REVENUE MAY NOT BE POSTED HERE, AND `purchase` WAS ON THIS LIST.
//
// This route is unauthenticated by design — it is named in PUBLIC_PREFIXES so a
// signed-out ad click is still counted — and it writes with the service-role
// key into `website_analytics_events`: the SAME table payment-webhook.ts writes
// REAL settled sales into, carrying utm_source, utm_medium, utm_campaign and an
// event_payload with the order id and amount paid. Grouping those purchase rows
// by campaign is, in that file's own words, the whole purpose of writing them.
//
// So accepting `purchase` from an anonymous body made attributed revenue
// attacker-writable and indistinguishable from a real order. Proved on the
// harness with no cookie: POST {"eventType":"purchase","payload":{"value":99999}}
// answered 200 and landed a purchase row. The per-session cap does not help —
// sessionId comes from the same body, so rotating it costs nothing.
//
// The sibling public relay already states the rule for itself
// (api/ads/funnel-event/route.ts): "Purchase is not accepted here at all — it is
// derived from the order's own settled payment state, which is the only place
// revenue may come from." This route now says the same.
//
// Nothing legitimate is lost: no client code dispatches a purchase through
// `vanta:analytics`, and recordAnalyticsPurchase in payment-webhook.ts writes
// the real row directly. A browser-side purchase signal, if one is ever wanted
// for a pixel, needs its own event type so reporting can tell the two apart.
const ALLOWED_EVENTS = new Set([
  "session_start",
  "page_view",
  "add_to_cart",
  "remove_from_cart",
  "update_cart_quantity",
  "begin_checkout",
  // Liveness ping for /admin/live (the live-visitor dashboard) — sent every
  // 15s while a tab is visible. Safe on the same anonymous-write footing as
  // page_view/session_start: it carries no revenue or order data, nothing
  // reads it back into a funnel/attribution report, and it is excluded from
  // getCurrentOnlineVisitorCount's event_type list on purpose (that reader
  // still means "a real navigation happened", not "a tab is still open").
  "heartbeat",
  // ---- THE TOP OF THE WHEEL FUNNEL.
  //
  // The wheel is the store's acquisition offer, so how many people are shown
  // the invitation and how many take it is the number that decides whether the
  // funnel works at all. None of it is reachable any other way: an invitation
  // that is never accepted leaves no trace on the server, so without these
  // three the only measurable point is the spin itself — a conversion rate with
  // no denominator.
  //
  // On the same footing as page_view, and for the same reason: no revenue, no
  // order, nothing a report treats as money. Everything BELOW the invitation —
  // who span, what they won, which dose they chose, whether they redeemed — is
  // already a row in customer_offers, written server-side, and is read from
  // there rather than believed from a browser.
  "spin_invite_shown",
  "spin_invite_skipped",
  "spin_invite_accepted",
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
      // No country/city field here on purpose — geo is resolved server-side
      // from Vercel's edge headers (see `geo` below), never from anything
      // the client claims.
      deviceType?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
      utmContent?: string;
      utmTerm?: string;
      ttclid?: string;
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

    // This endpoint is public and writes with the service-role key, so throttle
    // it (per session) to stop a bot flooding the analytics table — the same
    // speed-bump used by contact/coupon-validate/back-in-stock. Fails open.
    const rate = await checkRateLimit(`analytics:${sessionId}`, 120, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 });
    }
    // S5: a per-session limit alone is bypassable by rotating the client-supplied
    // sessionId, so also cap per IP. Generous ceiling so shared IPs (offices,
    // carrier NAT) with many real visitors aren't blocked.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const ipRate = await checkRateLimit(`analytics-ip:${ip}`, 600, 60);
    if (!ipRate.allowed) {
      return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429 });
    }

    // IDENTITY, SERVER-VERIFIED ONLY. Nothing above this line reads an
    // identity from the request body — resolveAnalyticsUserId only ever sees
    // the GoTrue user this route itself looked up from the session cookie, so
    // there is no field a client can set to claim to be someone else, or to
    // claim the admin/staff role that would otherwise exclude them from the
    // live-visitor dashboard. Fails soft to anonymous (userId stays null) on
    // any session-verification hiccup — a GoTrue blip must never break
    // tracking for the anonymous majority of traffic, which never touches
    // this cookie at all.
    let userId: string | null = null;
    try {
      const user = await getAuthenticatedUser();
      userId = resolveAnalyticsUserId(user, user ? detectRoleFromUser(user) : "unknown");
    } catch (identityError) {
      console.error("[analytics/track] identity resolution failed, treating as anonymous", identityError);
    }

    // GEO, SERVER-RESOLVED ONLY. Vercel's edge network has already resolved
    // country/city before this request reaches the app; a client-supplied
    // country/city is never read (the browser tracker never sent one anyway).
    // No IP address is read for this — see request-geo.ts.
    const geo = resolveCoarseGeoFromHeaders(request.headers);
    const userAgent = request.headers.get("user-agent");
    // Display filter for /admin/live only (bot-detection.ts) — never an
    // access control, never changes what this route does with the request.
    const isBot = isLikelyBotUserAgent(userAgent);

    // The three creative-attribution columns, plus user_id/is_bot below, ship
    // with migrations. Until a migration is applied its columns do not exist,
    // and including them would make PostgREST reject the entire insert —
    // switching off first-party analytics that has worked for months. See
    // analytics-column-fallback.ts.
    const error = await insertAnalyticsEvent(
      {
        event_type: eventType,
        page_path: pagePath,
        page_url: normalizeText(body.pageUrl, 1200),
        referrer: normalizeText(body.referrer, 1200),
        session_id: sessionId,
        visitor_id: normalizeText(body.visitorId, 120),
        user_agent: normalizeText(userAgent, 700),
        // NEVER FOR A HEARTBEAT. Every other event type keeps the existing
        // stored IP (unchanged behavior, unrelated to this feature); a
        // heartbeat is pure liveness-ping traffic for /admin/live and the
        // requirement for that feature is explicit: no raw IP retained. Geo
        // for a heartbeat comes entirely from the header-resolved `geo`
        // above, which never touches the address at all.
        ip_address: eventType === "heartbeat" ? null : normalizeIpAddress(request.headers.get("x-forwarded-for")),
        country: geo.country,
        city: geo.city,
        device_type: normalizeText(body.deviceType, 80),
        // CAMPAIGN TAGS ARE THE JOIN KEY, SO THEY ARE STORED THE WAY THE JOIN
        // EXPECTS THEM — normalizeCampaignTag, not normalizeText.
        //
        // The browser tracker reads these with a bare
        // `params.get("utm_campaign")` and posts them RAW; it never goes
        // through parseAttributionTouch, which is what lowercases the tags and
        // rejects an unexpanded platform macro on the order side. So an ad
        // tagged `?utm_content=Hook_A` wrote `Hook_A` here and `hook_a` to
        // order_attribution, and ads-spend-roas.sql lower()s the order side on
        // read — meaning the two halves of the same funnel grouped the same
        // creative under two different keys, and `{{campaign.name}}` from a
        // platform that failed to substitute its own macro was stored as
        // though it were a campaign name.
        //
        // Normalised HERE rather than in the tracker because this is the one
        // write path every client reaches, including a browser still running a
        // cached bundle.
        utm_source: normalizeCampaignTag(body.utmSource),
        utm_medium: normalizeCampaignTag(body.utmMedium),
        utm_campaign: normalizeCampaignTag(body.utmCampaign),
        event_payload: normalizePayload(body.payload),
        created_at: new Date().toISOString(),
      },
      {
        utm_content: normalizeCampaignTag(body.utmContent),
        utm_term: normalizeCampaignTag(body.utmTerm),
        // A click id is an opaque token the ad platform matches on, never a key
        // we group by — lowercasing one would break the conversion API.
        ttclid: normalizeText(body.ttclid, 260),
        user_id: userId,
        is_bot: isBot,
      },
    );

    if (error) {
      throw error;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    // Sanitised rather than echoed. safe-error.ts:5-16 is explicit that a raw
    // message hands a shopper a vendor hostname, a Postgres relation/column
    // name or an env-var name. Logged in full server-side, so no diagnostic
    // is lost; a genuinely shopper-written message still passes through,
    // because the sanitiser is a deny-list.
    console.error("[analytics/track]", error);
    const message = customerSafeMessage(error, "Unable to track event");
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}