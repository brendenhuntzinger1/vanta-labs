import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  /**
   * True when the limiter could not reach its storage and let the request
   * through without counting it. Callers may ignore it — the request is allowed
   * either way — but it means "unthrottled", not "under the limit", and the two
   * were previously indistinguishable.
   */
  degraded?: boolean;
}

// Durable, serverless-safe fixed-window rate limiter backed by rate_limit_hits.
//
// FAILS OPEN, DELIBERATELY, BUT NO LONGER SILENTLY (K-15a).
//
// A limiter outage must never take down checkout or coupon entry — this is an
// abuse speed-bump, not an auth control, and admin login has its own separate
// mechanism (admin_login_attempts) that does not depend on this module. That
// posture is kept. What changed is that it used to fail open with no log, no
// alert and no distinguishable return value, so "under the limit" and "the
// rate-limit table is unreachable" looked identical to every caller. If the
// table were ever dropped or unmigrated, EVERY rate limit in the application
// would be off, on every route, with nothing anywhere saying so.
//
// COUNTS AFTER RECORDING, NOT BEFORE (K-15b).
//
// It used to SELECT the count and then INSERT. Two hundred requests arriving
// together all read a count below the limit, all passed, and all then inserted —
// so the effective limit under a concurrent burst was unbounded, and automated
// abuse is concurrent by construction. Recording first means every request in a
// burst is already counted by the time any of them asks, so at most `limit` of
// them can see a count within it.
//
// The trade is that a denied request still costs a row, which makes the window
// slightly stricter under sustained abuse. That is the safe direction for the
// thing this protects: coupon-code enumeration, order creation, and two
// unauthenticated email-sending forms.
const ALERT_THROTTLE_MS = 5 * 60_000;
let lastDegradedAlertAt = 0;

async function alertOnce(bucket: string, stage: string, detail: string): Promise<void> {
  const now = Date.now();
  // One alert per five minutes: a storage outage hits every route at once, and
  // an alert per request would bury the signal it exists to raise.
  if (now - lastDegradedAlertAt < ALERT_THROTTLE_MS) return;
  lastDegradedAlertAt = now;
  try {
    await recordSystemAlert({
      type: "rate_limit_degraded",
      severity: "critical",
      message: `Rate limiting is OFF: ${stage} failed. Every throttled route is currently unlimited.`,
      context: { bucket, stage, detail },
    });
  } catch {
    // The alert itself is best-effort; the console line below is the floor.
  }
}

export async function checkRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();

  const degrade = async (stage: string, detail: string): Promise<RateLimitResult> => {
    console.error("[rate-limit] FAILING OPEN — throttle not applied", bucket, stage, detail);
    await alertOnce(bucket, stage, detail);
    return { allowed: true, retryAfterSeconds: 0, degraded: true };
  };

  try {
    // 1. RECORD FIRST. This is the whole of the concurrency fix: a burst is
    //    counted before any member of it asks how big the burst is.
    const { error: insertError } = await supabaseAdmin.from("rate_limit_hits").insert({ bucket });
    if (insertError) {
      return await degrade("insert", insertError.message ?? String(insertError));
    }

    // 2. THEN COUNT, including the hit just recorded — so the comparison is
    //    `> limit`, not `>= limit`: the limit-th request is the last allowed one.
    const { count, error } = await supabaseAdmin
      .from("rate_limit_hits")
      .select("id", { count: "exact", head: true })
      .eq("bucket", bucket)
      .gt("created_at", windowStart);

    if (error) {
      return await degrade("count", error.message ?? String(error));
    }

    if ((count ?? 0) > limit) {
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }

    // A ~1% sampled cleanup of old rows keeps the table from growing unbounded
    // without a scheduled job. Never allowed to affect the decision above.
    if (Math.random() < 0.01) {
      await supabaseAdmin
        .from("rate_limit_hits")
        .delete()
        .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    }

    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    return await degrade("throw", error instanceof Error ? error.message : String(error));
  }
}

/** Test-only: the alert throttle is module state and would leak between cases. */
export function __resetRateLimitAlertThrottle(): void {
  lastDegradedAlertAt = 0;
}
