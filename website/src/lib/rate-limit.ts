import { supabaseAdmin } from "@/lib/supabase-server";

// Distributed rate limiter backed by the rate_limit_hits table, so limits hold
// across serverless instances (an in-process Map resets on every cold start and
// is trivially bypassed). Sliding-window: count hits in the last `windowSeconds`
// for a bucket; block when the count reaches `limit`.

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  action: string;
  identifier: string; // usually the client IP
  limit: number;
  windowSeconds: number;
}

const ALLOW: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

// Returns { allowed } and records the hit when allowed. FAILS OPEN: if the table
// is missing (migration pending) or the DB errors, requests are allowed so a
// limiter outage can never take checkout/contact down.
export async function checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
  const identifier = (options.identifier || "unknown").slice(0, 100);
  const bucket = `${options.action}:${identifier}`;
  const windowStart = new Date(Date.now() - options.windowSeconds * 1000).toISOString();

  try {
    const { count, error } = await supabaseAdmin
      .from("rate_limit_hits")
      .select("id", { count: "exact", head: true })
      .eq("bucket", bucket)
      .gte("created_at", windowStart);

    if (error) {
      if (String(error.code) === "42P01") return ALLOW; // table missing → fail open
      throw error;
    }

    if ((count ?? 0) >= options.limit) {
      return { allowed: false, retryAfterSeconds: options.windowSeconds };
    }

    // Record this hit (best-effort). Also opportunistically prune old rows for
    // this bucket so the table doesn't grow unbounded.
    await supabaseAdmin.from("rate_limit_hits").insert({ bucket, created_at: new Date().toISOString() });
    await supabaseAdmin.from("rate_limit_hits").delete().eq("bucket", bucket).lt("created_at", windowStart);

    return ALLOW;
  } catch {
    return ALLOW; // fail open on any unexpected error
  }
}

// Standard 429 body for a blocked request.
export function rateLimitedResponseBody(message = "Too many requests. Please slow down and try again shortly.") {
  return { success: false, error: message };
}
