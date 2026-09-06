import { NextResponse, after } from "next/server";
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
 * AND IT SAYS NOTHING WITH ITS TIMING EITHER. Making every body identical only
 * closed half the oracle. The relay AWAITED the TikTok call, and that call only
 * happens when a line matched the catalogue — so a real slug answered a TikTok
 * round trip later than an unknown one, and the same enumeration was available
 * to anyone with a stopwatch. In production both gates are open
 * (`credentialStatus().configured` and `serverAdsReportingAllowed()`), which is
 * exactly where it mattered; the harness cannot reproduce it because the second
 * gate denies outside a production deployment, so this one is reasoned from the
 * code rather than measured locally, and closed the same way regardless.
 *
 * Everything that touches the catalogue therefore runs in `after()`: the reply
 * is sent first, and the lookup, the pricing decision and the delivery all
 * happen behind it. The response time now depends on the rate limiter and the
 * request body alone — neither of which knows what is in the catalogue. It is
 * also simply faster for the shopper whose page fired the relay, which used to
 * wait on TikTok for nothing.
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

    // Read off the request before the response is sent; `request` is not
    // something to reach into from a deferred callback.
    const userAgent = request.headers.get("user-agent");
    const ttclid =
      typeof body.ttclid === "string" && body.ttclid.trim() ? body.ttclid.trim().slice(0, 260) : null;
    const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 1200) : undefined;
    const lines = Array.isArray(body.lines) ? body.lines : [];
    const event = String(body.event ?? "");
    const eventId = String(body.eventId ?? "");
    const claimedTotal = body.claimedTotal;

    // EVERYTHING BELOW TOUCHES THE CATALOGUE, SO NONE OF IT MAY HAPPEN BEFORE
    // THE REPLY. See the header: awaiting it made the response time itself an
    // existence oracle. `after` also keeps the work reliable on Vercel, which a
    // bare un-awaited promise would not.
    after(async () => {
      try {
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

        const decision = decideRelay({ event, eventId, lines, claimedTotal }, catalog);
        if (!decision.ok) return;

        await sendServerEvents([
          {
            event: decision.event,
            eventId: decision.eventId,
            occurredAt: new Date(),
            user: {
              // The click id is the strongest match signal available for a
              // visitor who has not identified themselves. Null for organic
              // traffic, and null is the correct answer there — never
              // substitute anything.
              ttclid,
              ip,
              userAgent,
            },
            properties: {
              contents: decision.contents,
              currency: "USD",
              value: decision.value,
            },
            pageUrl,
          },
        ]);
      } catch {
        // A measurement failure is a measurement failure. It has already been
        // acknowledged to the page and there is nobody left to tell.
      }
    });

    // Uniform ack — outcome.delivered / decision.totalOverridden are NOT
    // returned, or they would re-open the price/existence oracle this closes.
    return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
  } catch {
    // Never surface a measurement failure to a shopper's page.
    return NextResponse.json(ACK, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
