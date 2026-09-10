import "server-only";

import { getRequiredEnv } from "@/lib/env";
import { releaseInventoryForOrder } from "@/lib/inventory-reservation";
import { veyraApiBase, veyraSecretKey } from "@/lib/express-checkout-service";
import { recordSystemAlert } from "@/lib/monitoring";
import { classifyDeadSession } from "@/lib/payment-failure";
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
 * How long after a decline a lost success is still worth asking about.
 *
 * A Veyra checkout session lives an hour, and a processor exhausts its webhook
 * retries well inside a day. Twenty-four hours therefore covers every case where
 * a charge on this session could still be unaccounted for, while keeping the
 * ordinary decline — which is most of them — out of the poll queue after a day.
 */
const RECONCILE_FAILED_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/**
 * When a still-unresolved checkout is retired as ABANDONED.
 *
 * The processor only calls a session dead (failed / expired / canceled) if it
 * says so itself; Veyra leaves a walked-away checkout reading "open", or stops
 * answering for it, indefinitely. Until 2026-09-05 those rows stayed
 * pending_payment forever, were polled on every tick, and re-raised the
 * 24-hour backlog warning every six hours — 30 open copies in production for
 * four August checkouts nobody could ever clear. A week with no charge, no
 * webhook and no processor confirmation is not a payment in flight. Retiring
 * it is also reversible: a late payment.succeeded webhook still moves a
 * payment_failed order to paid (payment-webhook.ts only refuses that for
 * refunded/canceled money), so nothing charged can be lost here.
 */
const RECONCILE_ABANDON_DAYS = 7;
const RECONCILE_ABANDON_MS = RECONCILE_ABANDON_DAYS * 24 * 60 * 60 * 1000;
/**
 * Timeout on ONE poll of the processor.
 *
 * K-19 gave every outbound Veyra call in veyra-membership.ts a 15s timeout,
 * because "a hung processor held a checkout or a renewal open until the
 * platform killed it". This file calls the same API and was missed. It is the
 * worse place to miss: fetch has no default request timeout, so one hung
 * connection here consumed the WHOLE 60s function budget, and every other job
 * sharing the sweep — campaigns, automations, expiry — was cut off with it.
 * 15s matches the value the codebase already chose for this third party.
 */
const RECONCILE_REQUEST_TIMEOUT_MS = 15_000;
/**
 * How long the polling loop may run before it stops and leaves the rest to the
 * next tick.
 *
 * The read is bounded at 500 rows (10 pages x 50) but the WORK was not: 500
 * sequential HTTP round trips cannot finish inside maxDuration = 60 whatever
 * each one costs, so at any real backlog this job tripped the route's watchdog
 * on every single tick and got killed mid-run. Stopping deliberately is
 * strictly better than being killed: the sweep is idempotent, the read is
 * NEWEST FIRST (see below), and a freshly charged order is therefore always at
 * the front of the queue. 30s leaves the other sweep jobs half the budget.
 */
const RECONCILE_WORK_BUDGET_MS = 30_000;
/**
 * How long the backlog warning stays quiet after firing.
 *
 * One aggregate row per sweep was not enough. A backlog only clears when a
 * human acts on it, so the same unresolved orders re-alerted on every run —
 * 43 firings in 22 hours for two orders, which is exactly the "operators learn
 * to ignore it" failure the per-sweep aggregation was meant to prevent.
 *
 * Persisted rather than a module-level timestamp: each cron run is a fresh
 * serverless invocation, so an in-memory clock is always empty and would
 * throttle nothing. (inventory-reservation.ts can use an in-memory throttle
 * because its alerts fire many times within ONE request; these fire once.)
 */
const BACKLOG_ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;
/**
 * Renamed from "express_reconcile_backlog": the query this reports on matches
 * ANY order with a processor session id, and in production it has only ever
 * fired for plain card checkouts. Nothing reads alert types programmatically
 * (monitoring.ts stores and lists them), so the rename costs only the grouping
 * of historical rows — which were misleading anyway.
 */
const BACKLOG_ALERT_TYPE = "payment_reconcile_backlog";

/**
 * Has this alert type been quiet long enough to fire again?
 *
 * Fails OPEN in every error path — a throttle must never be the reason a real
 * warning goes unsent.
 */
async function backlogAlertIsDue(type: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("system_alerts")
      .select("created_at")
      .eq("type", type)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return true;
    const last = Date.parse(String((data[0] as { created_at?: string }).created_at ?? ""));
    if (!Number.isFinite(last)) return true;
    return Date.now() - last > BACKLOG_ALERT_THROTTLE_MS;
  } catch {
    return true;
  }
}

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
  /** Whatever else Veyra sends: a failed session may carry its decline reason. */
  [key: string]: unknown;
}

interface PendingOrderRow {
  order_id: string;
  payment_id: string | null;
  created_at: string;
  /** Null reads as the card lane; a manual method is never retired here. */
  payment_method?: string | null;
  /**
   * `pending_payment` for the ordinary backlog, or `payment_failed` for a
   * recently-declined order being re-checked for a lost success (see the `.or`
   * on the read). A failed row is only ever SETTLED here — never retired again,
   * and never counted toward the unresolved backlog.
   */
  payment_status?: string | null;
  payment_failed_at?: string | null;
}

export interface ReconcileResult {
  checked: number;
  settled: number;
  /** Retired as definitively-never-charged, so they stop being polled. */
  failedOut: number;
  /** Still genuinely unknown at the processor. */
  unresolved: number;
  /**
   * Retirements declined because the order had already moved (a webhook won).
   * Absent when none — the sweep's output stays quiet on a clean run.
   */
  raced?: number;
  /**
   * Rows this run READ but never polled, because the work budget ran out.
   *
   * Reported because the loop is newest-first: what gets left behind is the
   * OLDEST queue, and an unpolled row is also never retired by the 7-day rule,
   * which lives inside the poll loop. A number that stays high tick after tick
   * means the oldest pending orders are being starved and will sit for ever.
   */
  unpolled?: number;
}

async function fetchSessionStatus(sessionId: string): Promise<VeyraSessionStatus | null> {
  try {
    const response = await fetch(`${veyraApiBase()}/api/v1/checkout_sessions/${encodeURIComponent(sessionId)}`, {
      // AbortSignal.timeout rejects with a TimeoutError, which the catch below
      // already treats as "no answer" — the same outcome as a non-ok response.
      signal: AbortSignal.timeout(RECONCILE_REQUEST_TIMEOUT_MS),
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
  const failedLookback = new Date(Date.now() - RECONCILE_FAILED_LOOKBACK_MS).toISOString();
  const orders: PendingOrderRow[] = [];
  // A FAILED READ IS NOT AN EMPTY BACKLOG.
  //
  // This loop used to `break` on `error || !data || data.length === 0`, folding
  // the one condition that means "this sweep could not look" into the one that
  // means "there is nothing to settle". The run then returned
  // { checked: 0, settled: 0, … } — indistinguishable from a clean sweep — and
  // the cron route reported success. So the single job standing between a
  // charged card and an order that reads unpaid could be failing on every tick
  // while the sweep's own output said all was well.
  //
  // The failure is carried rather than thrown on the spot: the pages already
  // read are real work, and a charge that CAN be settled should be settled on
  // this run rather than waiting for the read to recover. It is raised once the
  // work is done, which the sweep route turns into a critical alert.
  let readError: unknown = null;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const from = page * RECONCILE_PAGE;
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_id, created_at, payment_method, payment_status, payment_failed_at")
      // PENDING IS NOT THE ONLY WAY A CHARGED ORDER CAN READ UNPAID.
      //
      // This polled `pending_payment` alone, and that left the exact shape of
      // David's 2026-09-09 purchase unrecoverable. A shopper whose first attempt
      // is declined and who then pays on a SECOND card in the SAME session
      // leaves an order already written payment_failed. If that success webhook
      // is then lost, nothing in the system ever looks at the row again: this
      // sweep excluded it, so the card is charged, the order reads declined, the
      // stock is released, and no alert fires anywhere. That is the
      // charged-but-invisible order this job exists to prevent, arriving through
      // the one door it was not watching.
      //
      // A failed row is only reconsidered while a charge on its session is still
      // plausible: it must still carry a session id, and it must have failed
      // within RECONCILE_FAILED_LOOKBACK_MS. Outside that window a failed order
      // is left alone, so the ordinary decline — by far the common case — is
      // polled once or twice and then forgotten rather than for ever.
      //
      // Re-settling is safe by construction: the paid flip is a compare-and-set,
      // the synthetic event id is deterministic, and paid_side_effects_at is
      // single-use, so a late real webhook and this replay cannot both run the
      // side effects.
      .or(`payment_status.eq.pending_payment,and(payment_status.eq.payment_failed,payment_failed_at.gte.${failedLookback})`)
      // NO `.not("payment_id", "is", null)` — AND THAT EXCLUSION WAS A HOLE.
      //
      // It was true that a row without a session id has nothing to poll, and
      // the polling loop below still skips those rows for exactly that reason.
      // But excluding them from the READ also put them beyond the 7-day
      // abandonment added on 2026-09-05, which is the one thing that stops a
      // pending order sitting for ever — the condition that change existed to
      // end. Found still open in production at 35 and 29 days.
      //
      // Session-less rows cost no round trip (they are never polled), so
      // widening the read cannot crowd a freshly charged order out of the work
      // budget. They are retired by the sweep below, after the main loop.
      .lt("created_at", cutoff)
      .order("created_at", { ascending: false })
      .range(from, from + RECONCILE_PAGE - 1);
    if (error) {
      readError = error;
      break;
    }
    if (!data || data.length === 0) break;
    // Collected before any row is mutated — updating rows out of the filter
    // mid-scan would shift the offsets and skip the rows in between.
    orders.push(...(data as PendingOrderRow[]));
    if (data.length < RECONCILE_PAGE) break;
  }

  if (orders.length === 0) {
    if (readError) throw asReconcileReadError(readError);
    return { checked: 0, settled: 0, failedOut: 0, unresolved: 0 };
  }

  const secret = getRequiredEnv("PAYMENT_WEBHOOK_SECRET");
  const staleFloor = Date.now() - RECONCILE_STALE_MS;
  const abandonFloor = Date.now() - RECONCILE_ABANDON_MS;
  let settled = 0;
  let failedOut = 0;
  let unresolved = 0;
  let stale = 0;
  /**
   * Retirements this run DECLINED to make because the row had moved.
   *
   * A guarded UPDATE matching zero rows is the success case of the guard, not a
   * failure — it means a webhook settled the order while this sweep was
   * reading. Counted so it is visible rather than indistinguishable from "there
   * was nothing to do", and because a rising number here means webhook
   * deliveries and the sweep are contending for the same orders.
   */
  let raced = 0;
  let ranOutOfTime = false;
  // What this run actually POLLED, which is not the same as what it read once a
  // budget can end the loop early. `checked` reports this, so the number an
  // operator reads is the work done rather than the size of the queue.
  let polled = 0;

  const deadline = Date.now() + RECONCILE_WORK_BUDGET_MS;

  for (const order of orders) {
    // Stop BEFORE starting another round trip we may not be able to finish.
    // Newest first, so what is left behind is the oldest and least urgent, and
    // the next tick starts again from the top.
    if (Date.now() >= deadline) {
      ranOutOfTime = true;
      break;
    }

    const sessionId = String(order.payment_id ?? "");
    if (!sessionId) continue;

    // A row included by the failed-lookback is here for ONE question: did this
    // session actually take the money? It is never retired again (it already
    // is payment_failed) and it never counts toward the unresolved backlog,
    // because an ordinary decline is not an unknown charge and must not raise
    // the "orders pending at the processor" warning.
    const reCheckingFailed = String(order.payment_status ?? "pending_payment") === "payment_failed";

    polled += 1;
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
        if (reCheckingFailed) {
          // This is the charged-but-invisible case actually being caught. The
          // shopper was told the card was not charged and the stock was
          // released, so an operator needs to know the order came back.
          await recordSystemAlert({
            type: "payment_recovered_after_failure",
            severity: "critical",
            message: `Order ${order.order_id} was recorded as FAILED but the processor reports its session as paid. `
              + "Reconciliation has settled it. The shopper was told the card was not charged and the stock and "
              + "store-credit holds were released when it failed, so confirm the order is fulfillable.",
            context: { order_id: order.order_id, session_id: sessionId },
          }).catch(() => {});
        }
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

    // Everything below RETIRES a pending order. A row we are only re-checking is
    // already retired, so it stops here: re-running the write would match zero
    // rows and be miscounted as a race, and re-releasing its inventory would be
    // a second release of a hold that is already gone.
    if (reCheckingFailed) continue;

    if (DEAD_SESSION_STATUSES.has(status)) {
      // The processor says this session is terminal and never captured, so the
      // order can be retired: no money to chase, and the stock it is holding is
      // not sold. Guarded on payment_status so a webhook that flipped it to
      // paid a moment ago is never overwritten.
      //
      // WHY it is retired is recorded beside the status. An `expired` or
      // `canceled` session is a shopper who walked away — an abandoned
      // checkout, no charge ever attempted. Only `failed` is the processor
      // saying no. Until 2026-09-04 both were written as the bare word
      // payment_failed and the admin could not tell them apart.
      const failure = classifyDeadSession(status, session);
      const retiredAt = new Date().toISOString();
      const { data: retired, error: failError } = await supabaseAdmin
        .from("orders")
        .update({
          payment_status: "payment_failed",
          payment_failure_kind: failure.kind,
          payment_failure_code: failure.code,
          payment_failure_reason: failure.reason,
          payment_failed_at: retiredAt,
          updated_at: retiredAt,
        })
        .eq("order_id", order.order_id)
        .eq("payment_status", "pending_payment")
        // READ ROWS-AFFECTED, NOT JUST THE ERROR. A guarded UPDATE that matches
        // nothing is not an error in PostgREST: `error` is null either way. So
        // `if (!failError)` ran the release on an order the guard had correctly
        // REFUSED to retire — i.e. one a webhook had just flipped to paid
        // between the read at the top of this sweep and this write. The hold on
        // a paid order's units has already been finalized, so releasing it puts
        // sold units back on the shelf: an oversell, from the one job whose
        // purpose is to protect a charged order.
        .select("order_id");
      if (!failError && (retired?.length ?? 0) > 0) {
        await releaseInventoryForOrder(order.order_id);
        failedOut += 1;
      } else if (!failError) {
        raced += 1;
      }
      continue;
    }

    // Still pending at the processor (open / processing / requires_action), or
    // unreadable. Leave it alone — it may yet charge — unless it has now sat
    // that way for RECONCILE_ABANDON_DAYS, at which point it is an abandoned
    // checkout and is retired so it stops being polled and stops re-raising the
    // backlog warning. Guarded on pending_payment for the same reason as the
    // dead-session retirement above.
    if (Date.parse(order.created_at) < abandonFloor) {
      const retiredAt = new Date().toISOString();
      const { data: abandoned, error: abandonError } = await supabaseAdmin
        .from("orders")
        .update({
          payment_status: "payment_failed",
          payment_failure_kind: "checkout_expired",
          payment_failure_code: "abandoned",
          payment_failure_reason:
            `No payment arrived in the ${RECONCILE_ABANDON_DAYS} days after checkout and the processor never `
            + "reported a charge. Retired as an abandoned checkout; no charge was attempted.",
          payment_failed_at: retiredAt,
          updated_at: retiredAt,
        })
        .eq("order_id", order.order_id)
        .eq("payment_status", "pending_payment")
        // Same reason as the dead-session write above.
        .select("order_id");
      if (!abandonError && (abandoned?.length ?? 0) > 0) {
        await releaseInventoryForOrder(order.order_id);
        failedOut += 1;
      } else if (!abandonError) {
        raced += 1;
      }
      continue;
    }
    unresolved += 1;
    if (Date.parse(order.created_at) < staleFloor) stale += 1;
  }

  // ---------------------------------------------------------------------
  // Orders that never recorded a processor session.
  //
  // The loop above skips these — correctly, there is nothing to ask about.
  // Until now the SELECT skipped them too, so nothing in the system could
  // ever retire them and they stayed pending_payment for ever.
  //
  // They are aged out on the SAME 7-day rule as an unresolvable session, and
  // for the same reason: no charge, no webhook, no processor record. Like that
  // one it is reversible — a late payment.succeeded still moves a
  // payment_failed order to paid, and the webhook identifies an order by its
  // id, not by a session — so nothing charged can be lost here.
  //
  // THE CARD LANE ONLY. A manual method (Cash App / Zelle / PayPal) has no
  // processor session by design and is meant to wait while the shopper sends
  // money and submits proof; retiring one on a timer would cancel a live
  // order. Null reads as card, which is what the column holds for this lane.
  // ---------------------------------------------------------------------
  for (const order of orders) {
    if (Date.now() >= deadline) break;
    if (String(order.payment_id ?? "")) continue;

    const method = String(order.payment_method ?? "card").trim().toLowerCase();
    if (method && method !== "card") continue;
    if (Date.parse(order.created_at) >= abandonFloor) continue;

    const retiredAt = new Date().toISOString();
    const { data: orphaned, error: orphanError } = await supabaseAdmin
      .from("orders")
      .update({
        payment_status: "payment_failed",
        payment_failure_kind: "checkout_expired",
        payment_failure_code: "abandoned",
        payment_failure_reason:
          `No processor checkout session was ever recorded for this order, and no payment arrived in the `
          + `${RECONCILE_ABANDON_DAYS} days after it was created. Retired as an abandoned checkout; no charge was attempted.`,
        payment_failed_at: retiredAt,
        updated_at: retiredAt,
      })
      .eq("order_id", order.order_id)
      .eq("payment_status", "pending_payment")
      // Same reason as the two writes above.
      .select("order_id");
    if (!orphanError && (orphaned?.length ?? 0) > 0) {
      await releaseInventoryForOrder(order.order_id);
      failedOut += 1;
    } else if (!orphanError) {
      raced += 1;
    }
  }

  if (stale > 0 && (await backlogAlertIsDue(BACKLOG_ALERT_TYPE))) {
    // One aggregate row, throttled — see BACKLOG_ALERT_THROTTLE_MS. Warning, not
    // critical: nothing here is known to be charged, it is simply unknown.
    //
    // WHAT THIS DELIBERATELY NO LONGER SAYS, because both were false and each
    // sent an operator somewhere there was nothing to do:
    //
    //   "express order(s)" — the query above matches any order carrying a
    //   session id, not just the wallet lane. The two orders that first
    //   triggered this in production were ordinary card checkouts
    //   (checkout_channel NULL, payment_method 'card').
    //
    //   "They hold inventory" — a checkout hold is DEFAULT_RESERVATION_MINUTES
    //   (15 min) and reservation_expiry reclaims it on the next sweep. By the
    //   time an order is 24h old its stock has been back on sale for ~23 of
    //   them. Nothing here is holding anything.
    await recordSystemAlert({
      type: BACKLOG_ALERT_TYPE,
      severity: "warning",
      message: `${stale} order(s) have been unresolved at the payment processor for over 24h. Most are abandoned checkouts, which need nothing: no money moved and their stock was released long ago. Worth a look only if the count keeps climbing, which would point at the processor being unreadable rather than at shoppers walking away.`,
      context: { stale, unresolved, checked: orders.length },
    });
  }

  if (ranOutOfTime) {
    // Not an alert: this is the designed behaviour at a backlog, it is safe
    // (idempotent, newest-first), and the next tick continues. Worth saying
    // once per run so a persistent backlog is visible in the logs.
    console.warn(
      `reconcileVeyraPendingPayments: stopped after ${Math.round(RECONCILE_WORK_BUDGET_MS / 1000)}s having polled `
      + `${polled} of ${orders.length} pending order(s); the rest are picked up on the next sweep.`,
    );
  }

  if (readError) {
    // Everything above still happened and is reported in the thrown message, so
    // an operator can see what the partial run did achieve.
    throw asReconcileReadError(readError, { checked: polled, settled, failedOut, unresolved });
  }

  // Only rows that HAVE a session were ever candidates for polling; the
  // session-less ones are skipped by design and retired by the loop below, so
  // counting them as starved would report a backlog that does not exist.
  const pollable = orders.filter((order) => String(order.payment_id ?? "")).length;
  const unpolled = Math.max(0, pollable - polled);
  return {
    checked: polled,
    settled,
    failedOut,
    unresolved,
    ...(raced > 0 ? { raced } : {}),
    ...(unpolled > 0 ? { unpolled } : {}),
  };
}

/**
 * The read failure, as an Error the sweep route will surface.
 *
 * Rejecting is the whole point: /api/cron/sweep records a rejected job as a
 * critical `cron_sweep_failed` alert, and a silent zero records nothing.
 */
function asReconcileReadError(cause: unknown, progress?: ReconcileResult): Error {
  const detail = cause instanceof Error ? cause.message : String((cause as { message?: string })?.message ?? cause);
  const done = progress
    ? ` ${progress.settled} settled, ${progress.failedOut} failed out and ${progress.unresolved} left unresolved `
      + `from the ${progress.checked} order(s) it did read.`
    : "";
  return new Error(
    `Payment reconciliation could not read pending orders, so an unknown number of charged orders may still `
    + `read unpaid: ${detail}.${done}`,
  );
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
