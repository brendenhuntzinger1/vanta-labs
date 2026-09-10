import "server-only";

import { serverAdsReportingAllowed } from "@/lib/ads/ads-environment";
import { siteUrl } from "@/lib/site-identity";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// PAID, BUT TIKTOK WAS NEVER TOLD.
//
// A Purchase conversion is only reported when somebody performs a GET on
// /api/ads/purchase-event/[orderId], and the only thing that ever does that is
// the order-confirmation page. That route's own header says so:
//
//   "It does NOT fire for a customer who never opens the confirmation page —
//    closing that gap needs a reconciliation job over paid orders."
//
// This is that job.
//
// The gap is not theoretical and it is not rare. Between 2026-09-04 and
// 2026-09-10 the store took four paid orders; three reached TikTok and one —
// VL-AC6B5634, $159.97, shipped and in transit — has no row in
// ad_purchase_events_sent for tiktok OR reddit. It was never reported and,
// before this job, never would be. That is 18% of the week's revenue invisible
// to the bid optimiser, and the customer did nothing unusual: they paid and
// closed the tab.
//
// WHY THIS CALLS THE ROUTE RATHER THAN RE-IMPLEMENTING IT. Everything that
// decides whether an order is a conversion lives in that route — the paid gate,
// the slug resolution, Advanced Matching, the per-platform INSERT claim that
// makes one sale exactly one conversion, the release path when a send throws,
// and the Snap and Reddit legs. Reproducing that here would be a second opinion
// about whether a purchase happened, and the two copies would drift. Asking the
// route is the whole point: it is already idempotent, so a re-run is safe, and a
// fix to the reporting rules lands in one place.
//
// DENY BY DEFAULT, like every other outbound ad path. serverAdsReportingAllowed
// is checked here as well as inside the route (K-16): a reconciliation job that
// scans real paid orders is exactly the thing that must not run against the live
// ad account from a preview deployment or a local box.
// ---------------------------------------------------------------------------

/**
 * How long after payment an order counts as missed rather than in-flight.
 *
 * The confirmation page asks within seconds of the redirect back from the
 * processor, and asks again when the payment poll announces the order paid. A
 * quarter of an hour is far past both and still soon enough that the conversion
 * lands inside TikTok's attribution window rather than as stale history.
 */
const STRANDED_AFTER_MS = 15 * 60 * 1000;

/**
 * Look back a week.
 *
 * Long enough to clear the existing backlog on the first few ticks, short
 * enough that the scan stays cheap and that nothing ancient is resurrected into
 * a report where it would land far outside its click's attribution window.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

/** Bound the work per tick — the sweep shares a 60-second budget with ~25 jobs. */
const DEFAULT_LIMIT = 10;

/** Per-order ceiling. The route does two outbound sends; it is not instant. */
const REQUEST_TIMEOUT_MS = 12_000;

export interface PurchaseReportRepairResult {
  scanned: number;
  /** Orders that now hold a tiktok ledger row because of this run. */
  reported: number;
  /** Asked, but no ledger row appeared — the route declined or the send failed. */
  failed: number;
  /** Candidates left for the next tick by `limit`. */
  deferred?: number;
  /**
   * Set when the environment refused the whole run, carrying the reason from
   * ads-environment. Reported rather than thrown so the sweep output says
   * "deliberately did nothing" instead of looking like a healthy zero.
   */
  refused?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;

/**
 * Report paid orders that never reached TikTok.
 *
 * Absence-keyed and idempotent, in the shape of repairMissingInventoryCommits:
 * it asks which paid orders have no ledger row rather than tracking failures, so
 * it clears the existing backlog as well as protecting future orders. Never
 * throws — the sweep reports a rejected job, and this one failing must not take
 * the other jobs' results down with it.
 */
export async function repairMissingPurchaseReports(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}): Promise<PurchaseReportRepairResult> {
  const result: PurchaseReportRepairResult = { scanned: 0, reported: 0, failed: 0 };

  const environment = serverAdsReportingAllowed();
  if (!environment.allowed) {
    result.refused = environment.reason;
    return result;
  }

  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = Math.max(1, options?.limit ?? DEFAULT_LIMIT);
  const doFetch = options?.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = (options?.baseUrl ?? siteUrl()).replace(/\/+$/, "");

  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const strandedBefore = new Date(now.getTime() - STRANDED_AFTER_MS).toISOString();

  // Only "paid" — the route reports nothing for any other status, so widening
  // this would scan orders it is guaranteed to decline and call them failures.
  //
  // refunded_at IS NULL is this job's one departure from the confirmation page,
  // and it is deliberate. That page fires seconds after payment, long before a
  // refund could exist. This job runs later and CAN see one, so resurrecting a
  // returned sale as a fresh conversion would be reporting revenue the store
  // gave back — the opposite of the accuracy this job exists to provide.
  let candidates: Array<{ order_id?: string | null }> = [];
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, paid_at")
      .eq("payment_status", "paid")
      .is("refunded_at", null)
      .gte("paid_at", since)
      .lte("paid_at", strandedBefore)
      .order("paid_at", { ascending: true })
      .limit(limit * 4);
    if (error || !data) return result;
    candidates = data as Array<{ order_id?: string | null }>;
  } catch {
    return result;
  }

  const orderIds = candidates.map((row) => String(row.order_id ?? "")).filter(Boolean);
  if (orderIds.length === 0) return result;

  // One read for the whole batch. Keyed on platform because the ledger is
  // PRIMARY KEY (order_id, platform): an order that reached Reddit but not
  // TikTok is still a missing TikTok conversion, and asking about the order
  // alone would call it done.
  const reportedIds = await readReportedOrderIds(orderIds);

  const missing = orderIds.filter((orderId) => !reportedIds.has(orderId));
  result.scanned = missing.length;
  if (missing.length === 0) return result;

  const toRepair = missing.slice(0, limit);
  if (missing.length > toRepair.length) result.deferred = missing.length - toRepair.length;

  for (const orderId of toRepair) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        await doFetch(`${base}/api/ads/purchase-event/${encodeURIComponent(orderId)}`, {
          method: "GET",
          headers: { "cache-control": "no-store" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fall through to the ledger check. A transport failure and a refusal are
      // the same outcome here — no row — and the ledger is the honest witness.
    }
  }

  // VERIFY FROM THE LEDGER, NOT FROM THE RESPONSE.
  //
  // The route answers 200 with `{ found: false, event: null }` for an order it
  // declines to report, and 200 again when a send is rejected by TikTok. Neither
  // is a failure at the HTTP layer, so counting status codes would report
  // success for conversions that never happened — the exact class of bug the
  // Events API wrapper documents about TikTok's own envelope. A row in
  // ad_purchase_events_sent is the only evidence that anything was claimed.
  const afterIds = await readReportedOrderIds(toRepair);
  for (const orderId of toRepair) {
    if (afterIds.has(orderId)) result.reported += 1;
    else result.failed += 1;
  }

  return result;
}

/** Which of these orders already hold a TikTok row on the send ledger. */
async function readReportedOrderIds(orderIds: string[]): Promise<Set<string>> {
  const reported = new Set<string>();
  if (orderIds.length === 0) return reported;
  try {
    const { data } = await supabaseAdmin
      .from("ad_purchase_events_sent")
      .select("order_id, platform")
      .eq("platform", "tiktok")
      .in("order_id", orderIds);
    for (const row of (data ?? []) as Array<{ order_id?: string | null }>) {
      if (row.order_id) reported.add(String(row.order_id));
    }
  } catch {
    /* ledger unreadable — callers treat an empty set as "nothing known" */
  }
  return reported;
}
