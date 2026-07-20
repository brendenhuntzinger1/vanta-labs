import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getSiteUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const url = request.nextUrl.searchParams.get("url");

  const destination = url && url.startsWith(getSiteUrl()) ? url : "/cart";

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
