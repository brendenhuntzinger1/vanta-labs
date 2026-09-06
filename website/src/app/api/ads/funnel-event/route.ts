import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { decideRelay, type CatalogEntry } from "@/lib/ads/funnel-relay";
import { credentialStatus, sendServerEvents } from "@/lib/ads/tiktok-events-api";

/**
 * Report a browsing event to TikTok from the server as well as the browser.
 *
 * Called by the same components that fire the pixel, with the SAME event id, so
 * TikTok collapses the pair into one event rather than counting two. The browser
 * leg only runs after cookies are accepted, so consent still gates both — this
 * endpoint is never reached for a visitor who declined.
 *
 * It is a public endpoint, so it is written as though the caller is hostile:
 * rate limited per IP, product ids re-resolved against the catalogue, prices
 * taken from the catalogue rather than the request, and a claimed checkout total
 * accepted only when it is plausible for the merchandise it names. Purchase is
 * not accepted here at all — it is derived from the order's own settled payment
 * state, which is the only place revenue may come from.
 *
 * THE RESPONSE SAYS NOTHING ABOUT THE CATALOGUE, ON PURPOSE. This endpoint is
 * public and the storefront it measures is behind the login wall, so the reply
 * must not become a way to see behind that wall. An earlier version answered
 * `{sent:true,…,totalOverridden}` on a catalogue match and
 * `{sent:false,reason:"no line matched a catalogue product"}` on a miss — which
 * is an anonymous oracle twice over: probe a slug and the body tells you whether
 * it is a real product, and vary a claimed checkout total and `totalOverridden`
 * flips at the real price, so both the compound list AND its prices are
 * recoverable without an account. The relay still does all of that work
 * internally (TikTok must receive accurate events), but every path now returns
 * the SAME opaque acknowledgement, so an anonymous caller learns nothing it did
 * not already send. The one caller (lib/ads/relay-client.ts) is fire-and-forget
 * and never reads the body, so uniformity costs it nothing.
 *
 * It never fails loudly. A measurement relay returning an error to a product
 * page would trade a reporting gap for a broken page, which is the wrong way
 * round.
 */

// The single answer every outcome returns — match, miss, not-configured, or
// internal error alike. Carries no catalogue signal by construction.
const ACK = { received: true } as const;

export async function POST(request: Request) {
  try {
    if (!credentialStatus().configured) {
      return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
    }

    const ip = getRequestIpAddress(request) ?? "unknown";
    // Generous: a real shopper browsing quickly produces a steady trickle of
    // these, and throttling a genuine visitor loses real measurement.
    const rate = await checkRateLimit(`ads-funnel:${ip}`, 240, 60);
    if (!rate.allowed) {
      return NextResponse.json({ sent: false, reason: "rate limited" }, { status: 429 });
    }

    const body = (await request.json()) as {
      event?: string;
      eventId?: string;
      lines?: { slug?: unknown; quantity?: unknown }[];
      claimedTotal?: unknown;
      ttclid?: unknown;
      pageUrl?: unknown;
    };

    const slugs = [
      ...new Set(
        (Array.isArray(body.lines) ? body.lines : [])
          .map((line) => String(line?.slug ?? "").trim())
          .filter(Boolean)
          .slice(0, 50),
      ),
    ];
    if (slugs.length === 0) {
      return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
    }

    // The catalogue is the price authority. sale_price_cents wins when set,
    // exactly as the storefront resolves it.
    const catalog = new Map<string, CatalogEntry>();
    const { data: products } = await supabaseAdmin
      .from("products")
      .select("slug, name, price_cents, sale_price_cents")
      .in("slug", slugs);
    for (const row of (products ?? []) as {
      slug?: string;
      name?: string | null;
      price_cents?: number | null;
      sale_price_cents?: number | null;
    }[]) {
      if (!row.slug) continue;
      const cents = Number(row.sale_price_cents) > 0 ? Number(row.sale_price_cents) : Number(row.price_cents ?? 0);
      catalog.set(row.slug, { slug: row.slug, name: row.name ?? null, price: cents / 100 });
    }

    const decision = decideRelay(
      {
        event: String(body.event ?? ""),
        eventId: String(body.eventId ?? ""),
        lines: Array.isArray(body.lines) ? body.lines : [],
        claimedTotal: body.claimedTotal,
      },
      catalog,
    );

    if (!decision.ok) {
      return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
    }

    // Fire-and-forget: the delivery outcome is deliberately not surfaced (that
    // was half the oracle). We still await so a thrown error hits the catch.
    await sendServerEvents([
      {
        event: decision.event,
        eventId: decision.eventId,
        occurredAt: new Date(),
        user: {
          // The click id is the strongest match signal available for a visitor
          // who has not identified themselves. Null for organic traffic, and
          // null is the correct answer there — never substitute anything.
          ttclid: typeof body.ttclid === "string" && body.ttclid.trim() ? body.ttclid.trim().slice(0, 260) : null,
          ip,
          userAgent: request.headers.get("user-agent"),
        },
        properties: {
          contents: decision.contents,
          currency: "USD",
          value: decision.value,
        },
        pageUrl: typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 1200) : undefined,
      },
    ]);

    // Uniform ack — outcome.delivered / decision.totalOverridden are NOT
    // returned, or they would re-open the price/existence oracle this closes.
    return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    // Never surface a measurement failure to a shopper's page.
    return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
