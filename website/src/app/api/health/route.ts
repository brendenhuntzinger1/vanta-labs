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

  // Readiness reflects the DB in the HTTP STATUS, not just the body: return 503
  // when the database is unreachable so a status-code-only uptime monitor (the
  // common case) actually alerts instead of seeing a false 200.
  const healthy = database === "ok";
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      database,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
