import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getSiteUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const url = request.nextUrl.searchParams.get("url");

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
  }

  return NextResponse.redirect(destination);
}
