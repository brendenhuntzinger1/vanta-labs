import "server-only";

import { getRequiredEnv } from "@/lib/env";
import { releaseInventoryForOrder } from "@/lib/inventory-reservation";
import { veyraApiBase, veyraSecretKey } from "@/lib/express-checkout-service";
import { recordSystemAlert } from "@/lib/monitoring";
import { signWebhookPayload } from "@/lib/payment-provider";
import { processPaymentWebhook } from "@/lib/payment-webhook";
import { supabaseAdmin } from "@/lib/supabase-server";

// -------------------------------------------------------------------------
// Settlement backstop for the express (Apple Pay) lane.
//
// The signed webhook is the authoritative paid signal. This is what runs when
// one is LOST — the case the express lane makes newly dangerous, because it is
// the first path where a missing webhook means a charged card sitting against
// an order that reads unpaid, with stock still only reserved.
//
// It deliberately settles by feeding a signed event through the REAL webhook
// handler rather than flipping the row itself: that way it inherits the
// paid_side_effects_at exactly-once claim, the event dedup, and every
// side-effect in one place. If the genuine webhook turns up later, its own
// event id is different but the claim has already been spent, so nothing runs
// twice.
// -------------------------------------------------------------------------

/** How long a charge may sit unsettled before we go and ask about it. */
const RECONCILE_AFTER_MS = 10 * 60 * 1000;
const RECONCILE_PAGE = 50;
/** Bounds one sweep. Paging (rather than a single capped batch) is what stops
 *  permanently-unresolvable rows crowding a newly charged order out of the
 *  run — the one order that actually needed polling. */
const RECONCILE_MAX_PAGES = 10;
/** Past this a still-unknown charge needs a human, not another poll. */
const RECONCILE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Mapped session statuses that mean the charge definitively did NOT happen.
 *
 * Veyra's v1 by-id read maps its raw status through `checkoutStatusFromRuntime`:
 * `succeeded|paid → paid`, `open|processing|requires_action → payment_pending`,
 * and these three, each of which is terminal with no money moved. Anything that
 * merely MIGHT have charged folds into `payment_pending` and is left alone.
 */
const DEAD_SESSION_STATUSES = new Set(["failed", "expired", "canceled", "cancelled"]);

interface VeyraSessionStatus {
  status?: string;
}

interface PendingOrderRow {
  order_id: string;
  payment_id: string | null;
  created_at: string;
}

export interface ReconcileResult {
  checked: number;
  settled: number;
  /** Retired as definitively-never-charged, so they stop being polled. */
  failedOut: number;
  /** Still genuinely unknown at the processor. */
  unresolved: number;
}

async function fetchSessionStatus(sessionId: string): Promise<VeyraSessionStatus | null> {
  try {
    const response = await fetch(`${veyraApiBase()}/api/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${veyraSecretKey()}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as VeyraSessionStatus;
  } catch {
    return null;
  }
}

export async function reconcileVeyraPendingPayments(): Promise<ReconcileResult> {
  // Only orders that recorded a processor session id at checkout can be polled.
  // That is exactly the express lane: the card lane leaves payment_id null until
  // its own webhook fills it in, so those rows never match here.
  //
  // NEWEST FIRST, and paged to exhaustion. Both matter: rows that terminate
  // somewhere other than "paid" stay pending_payment, so with an unordered
  // single batch a growing set of unresolvable rows would eventually fill every
  // run and a freshly charged order whose webhook was lost would never be
  // polled at all — money moved, order reads unpaid, stock released at
  // reservation expiry. That is the exact failure this file exists to prevent.
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  const orders: PendingOrderRow[] = [];
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const from = page * RECONCILE_PAGE;
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_id, created_at")
      .eq("payment_status", "pending_payment")
      .not("payment_id", "is", null)
      .lt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .range(from, from + RECONCILE_PAGE - 1);
    if (error || !data || data.length === 0) break;
    // Collected before any row is mutated — updating rows out of the filter
    // mid-scan would shift the offsets and skip the rows in between.
    orders.push(...(data as PendingOrderRow[]));
    if (data.length < RECONCILE_PAGE) break;
  }

  if (orders.length === 0) {
    return { checked: 0, settled: 0, failedOut: 0, unresolved: 0 };
  }

  const secret = getRequiredEnv("PAYMENT_WEBHOOK_SECRET");
  const staleFloor = Date.now() - RECONCILE_STALE_MS;
  let settled = 0;
  let failedOut = 0;
  let unresolved = 0;
  let stale = 0;

  for (const order of orders) {
    const sessionId = String(order.payment_id ?? "");
    if (!sessionId) continue;

    const session = await fetchSessionStatus(sessionId);
    const status = String(session?.status ?? "").toLowerCase();

    // Veyra's v1 read maps a succeeded charge to "paid".
    if (status === "paid" || status === "succeeded") {
      // No `amount` is sent. The session's `amount_cents` is the
      // address-INDEPENDENT figure and is never rewritten with the shipping
      // and tax that were actually charged, so asserting it against
      // amount_paid (which includes both) flagged a mismatch on every single
      // order and held it out of fulfilment. The webhook skips the assertion
      // when no amount is present, which is also what a real Veyra delivery
      // does — its envelope carries no top-level amount either.
      const body = JSON.stringify({
        orderId: String(order.order_id),
        type: "payment.succeeded",
        paymentId: sessionId,
      });

      try {
        await processPaymentWebhook(
          body,
          signWebhookPayload(body, secret),
          secret,
          // Deterministic and distinct from any real delivery, so re-running the
          // sweep is a no-op rather than a second settlement attempt.
          `reconcile-${order.order_id}`,
        );
        settled += 1;
      } catch (settleError) {
        await recordSystemAlert({
          type: "express_reconcile_failed",
          severity: "critical",
          message: `A paid Apple Pay charge could not be settled from reconciliation. Order ${order.order_id} is charged but still reads unpaid.`,
          context: { order_id: order.order_id, session_id: sessionId, reason: String(settleError) },
        });
      }
      continue;
    }

    if (DEAD_SESSION_STATUSES.has(status)) {
      // The processor says this session is terminal and never captured, so the
      // order can be retired: no money to chase, and the stock it is holding is
      // not sold. Guarded on payment_status so a webhook that flipped it to
      // paid a moment ago is never overwritten.
      const { error: failError } = await supabaseAdmin
        .from("orders")
        .update({ payment_status: "payment_failed", updated_at: new Date().toISOString() })
        .eq("order_id", order.order_id)
        .eq("payment_status", "pending_payment");
      if (!failError) {
        await releaseInventoryForOrder(order.order_id);
        failedOut += 1;
      }
      continue;
    }

    // Still pending at the processor (open / processing / requires_action), or
    // unreadable. Leave it alone — it may yet charge.
    unresolved += 1;
    if (Date.parse(order.created_at) < staleFloor) stale += 1;
  }

  if (stale > 0) {
    // One aggregate row per sweep, not one per order — an alert that fires N
    // times an hour is an alert operators learn to ignore. Warning, not
    // critical: nothing here is known to be charged, it is simply unknown.
    await recordSystemAlert({
      type: "express_reconcile_backlog",
      severity: "warning",
      message: `${stale} express order(s) have been pending at the processor for over 24h — typically an abandoned 3DS challenge. They hold inventory and will never settle on their own; review and cancel or complete them.`,
      context: { stale, unresolved, checked: orders.length },
    });
  }

  return { checked: orders.length, settled, failedOut, unresolved };
}

/**
 * Retire armed-but-never-used wallet sessions.
 *
 * Purely hygiene — an expired intent is already refused everywhere by its
 * expires_at, and it never held stock or wrote an order. This just stops the
 * table filling with rows that read "open" forever.
 */
export async function expireStaleExpressIntents(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("express_checkout_intents")
    .update({ status: "expired" })
    .is("consumed_at", null)
    .eq("status", "open")
    .lt("expires_at", new Date().toISOString())
    .select("id");
  if (error || !data) return 0;
  return data.length;
}
