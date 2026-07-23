import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Durable, serverless-safe fixed-window rate limiter backed by rate_limit_hits.
// Counts hits for `bucket` within the trailing `windowSeconds`; if the count is
// already at `limit`, the request is denied. Otherwise a hit is recorded.
//
// Fails OPEN on any storage error — a limiter outage must never take down a
// legitimate customer flow (checkout, coupon entry). It's an abuse speed-bump,
// not an auth control.
export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();

  try {
    const { count, error } = await supabaseAdmin
      .from("rate_limit_hits")
      .select("id", { count: "exact", head: true })
      .eq("bucket", bucket)
      .gt("created_at", windowStart);

    if (error) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if ((count ?? 0) >= limit) {
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }

    // Record this hit (best-effort). A ~1% sampled cleanup of old rows keeps the
    // table from growing unbounded without a scheduled job.
    await supabaseAdmin.from("rate_limit_hits").insert({ bucket });
    if (Math.random() < 0.01) {
      await supabaseAdmin
        .from("rate_limit_hits")
        .delete()
        .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    }

    return { allowed: true, retryAfterSeconds: 0 };
  } catch {
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
