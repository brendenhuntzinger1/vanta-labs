import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

// Lightweight health/readiness probe for uptime monitors, load balancers, and
// deploy smoke checks. Liveness always returns 200 with a timestamp; readiness
// runs one cheap Supabase query so a monitor can distinguish "app up" from
// "app up but database unreachable" without ever throwing.
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  const startedAt = Date.now();
  let database: "ok" | "unreachable" = "unreachable";

  try {
    // Cheapest possible round-trip: fetch a single id, no count.
    const { error } = await supabaseAdmin
      .from("products")
      .select("id")
      .limit(1);
    if (!error) {
      database = "ok";
    }
  } catch {
    database = "unreachable";
  }

  return NextResponse.json(
    {
      status: "ok",
      database,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
