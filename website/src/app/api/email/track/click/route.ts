import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getSiteUrl } from "@/lib/env";
import { stampCartRecoveryEngagement } from "@/lib/email/engagement";
import { OFFER_COOKIE, OFFER_COOKIE_MAX_AGE_SECONDS } from "@/lib/offers/customer-offers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const url = request.nextUrl.searchParams.get("url");
  const offerToken = request.nextUrl.searchParams.get("o") ?? "";

  // Only redirect to our own origin. A prefix check (startsWith) is unsafe:
  // "https://site.com.evil.com" and "https://site.com@evil.com" both pass it.
  // Compare parsed origins instead, and always redirect to an absolute URL.
  const base = getSiteUrl();
  let destination = `${base}/cart`;
  if (url) {
    try {
      if (new URL(url).origin === new URL(base).origin) {
        destination = url;
      }
    } catch {
      // Malformed url param - fall through to the cart default.
    }
  }

  if (id) {
    try {
      await supabaseAdmin
        .from("abandoned_cart_emails")
        .update({ clicked_at: new Date().toISOString() })
        .eq("id", id)
        .is("clicked_at", null);
    } catch {
      // Non-fatal - the redirect still needs to happen.
    }
    await stampCartRecoveryEngagement("clicked", id);
  }

  const response = NextResponse.redirect(destination);

  // THE ENTITLEMENT TOKEN GOES IN AN httpOnly COOKIE, NOT IN THE DESTINATION.
  //
  // Identical treatment, and identical reasoning, to the retention
  // automations' click route: it is a bearer secret that grants a physical
  // product, so in a query string it would be readable by every script on the
  // landing page, sent in the Referer of everything that page fetches, picked
  // up by analytics and session recorders, and copied verbatim whenever the
  // customer shared the link. The checkout reads it server-side; the browser
  // never needs to see it.
  //
  // Anyone can put anything in `o`, and that costs nothing: the cookie is only
  // ever redeemed against a customer_offers row whose email must match the
  // checkout's. Junk should cost a failed lookup, not a Set-Cookie header no
  // proxy will forward — hence the length cap.
  if (offerToken && offerToken.length <= 128) {
    response.cookies.set({
      name: OFFER_COOKIE,
      value: offerToken,
      httpOnly: true,
      // Lax, not Strict: the shopper arrives from their mail client, which is a
      // cross-site top-level navigation, and Strict drops the cookie on exactly
      // the hop this exists for.
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: OFFER_COOKIE_MAX_AGE_SECONDS,
    });
  }

  return response;
}
