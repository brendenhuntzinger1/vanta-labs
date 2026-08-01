import { NextResponse } from "next/server";
import {
  loadIntentBySession,
  resolveShopperIdentity,
  veyraApiBase,
  type WalletPartialContact,
} from "@/lib/express-checkout-service";

export const dynamic = "force-dynamic";

// Browser -> here -> Veyra's session-scoped /shipping-rates.
//
// This hop is NOT optional and must NOT be short-circuited to our own shipping
// code, however tempting that is: calling Veyra is the ONLY thing that
// populates its locked-rates cache for this session, and that cache is the sole
// source /pay-bt trusts when it computes the charge. Skipping it charges the
// bare session amount with no shipping and no tax — the documented undercharge
// on the reference implementation.
//
// The proxy exists (rather than a direct browser call) for two reasons:
// Veyra's rates endpoint sets no CORS headers, and forwarding the shopper's own
// IP keeps Veyra's per-IP read bucket per-SHOPPER instead of collapsing every
// customer onto one serverless egress address.

interface ProxyBody {
  session_id?: string;
  contact?: WalletPartialContact & { postalCode?: string; postal_code?: string };
}

export async function POST(request: Request) {
  let body: ProxyBody;
  try {
    body = (await request.json()) as ProxyBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const sessionId = String(body.session_id ?? "").trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session." }, { status: 400 });
  }

  // Not an open proxy: the session must belong to a live intent of ours.
  const intent = await loadIntentBySession(sessionId);
  if (!intent || intent.consumed_at || new Date(intent.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "This checkout has expired. Please start again." }, { status: 410 });
  }

  const rawContact = body.contact ?? {};
  const { ip, userAgent } = resolveShopperIdentity(request);

  try {
    const response = await fetch(`${veyraApiBase()}/api/checkout/${encodeURIComponent(sessionId)}/shipping-rates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Truthful shopper attribution for Veyra's rate limiting and risk
        // signals — taken from THIS request's headers, never from the body.
        ...(ip ? { "x-forwarded-for": ip, "x-real-ip": ip } : {}),
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
      // Veyra's schema is .strict() and accepts EXACTLY these four fields.
      // Anything else 400s the whole request.
      body: JSON.stringify({
        contact: {
          postal_code: rawContact.postal_code ?? rawContact.postalCode ?? "",
          state: rawContact.state ?? "",
          city: rawContact.city ?? "",
          country: rawContact.country ?? "",
        },
      }),
    });

    const text = await response.text();
    // Returned VERBATIM. What the sheet displays must be byte-for-byte what
    // Veyra wrote to its cache and will charge — never a re-computation here.
    return new NextResponse(text, {
      status: response.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Express shipping-rates proxy failed", error);
    return NextResponse.json({ error: "We could not calculate shipping for that address." }, { status: 502 });
  }
}
