import { supabaseAdmin } from "@/lib/supabase-server";
import { planInventoryAdjustments, readQuantityAfter, type OrderItemRef } from "@/lib/inventory-fulfillment";
import { recordInventoryTransaction } from "@/lib/inventory-ledger";
import { invalidateCatalogCache } from "@/lib/catalog-cache";
import { recordSystemAlert } from "@/lib/monitoring";

// Enterprise inventory reservation (see src/lib/sql/inventory-reservations.sql).
// Stock is held atomically the instant a checkout/payment session is created,
// released on failure/cancel/expiry, and permanently deducted only on a
// verified paid webhook. Concurrent buyers can never oversell.

// A card/instant checkout must complete within 15 minutes of the hold.
export const DEFAULT_RESERVATION_MINUTES = 15;
// Manual/off-platform payments (Cash App/Zelle/PayPal) are verified by an admin
// later, so their hold survives longer; the sweep still reclaims truly
// abandoned ones, and an admin reject/cancel releases them immediately.
export const MANUAL_RESERVATION_MINUTES = 60 * 24; // 24h

export interface UnavailableLine {
  slug: string;
  variantId: string | null;
  /** Units the customer asked for. */
  quantity: number;
  /**
   * Units actually sellable right now, or null when it could not be read.
   *
   * Read AFTER the hold failed, so it is advisory rather than authoritative —
   * another checkout may take the last one a moment later. It exists so the
   * customer is told "only 2 left" instead of a bare "sold out", which is the
   * difference between adjusting the cart and abandoning it.
   */
  available: number | null;
  /** Product name, so the message can say WHICH item is short. */
  name: string | null;
}

export interface ReserveResult {
  ok: boolean;
  unavailable: UnavailableLine[];
  degraded: boolean;
}

/**
 * How many units of a line are sellable, for the customer-facing message only.
 *
 * Never used to decide whether a sale may proceed — that decision belongs to
 * the atomic UPDATE inside reserve_inventory(), which checks availability and
 * takes the hold in one row-locked statement. A read like this one is a
 * check-then-act race by construction and must never gate a purchase.
 */
async function readAvailable(
  slug: string,
  variantId: string | null,
): Promise<{ available: number | null; name: string | null }> {
  try {
    if (variantId) {
      const { data } = await supabaseAdmin
        .from("product_doses")
        .select("inventory_quantity, reserved_quantity, label")
        .eq("id", variantId)
        .maybeSingle<{ inventory_quantity: number | null; reserved_quantity: number | null; label: string | null }>();
      if (!data) return { available: null, name: null };
      return {
        available: Math.max(0, Number(data.inventory_quantity ?? 0) - Number(data.reserved_quantity ?? 0)),
        name: data.label ?? null,
      };
    }
    const { data } = await supabaseAdmin
      .from("products")
      .select("inventory_quantity, reserved_quantity, name")
      .eq("slug", slug)
      .maybeSingle<{ inventory_quantity: number | null; reserved_quantity: number | null; name: string | null }>();
    if (!data) return { available: null, name: null };
    return {
      available: Math.max(0, Number(data.inventory_quantity ?? 0) - Number(data.reserved_quantity ?? 0)),
      name: data.name ?? null,
    };
  } catch {
    // A failed lookup degrades the message, never the outcome.
    return { available: null, name: null };
  }
}

/**
 * One sentence telling the customer WHICH line is short and what to do.
 *
 * Names the item — "sorry, something sold out" makes the shopper guess which of
 * five lines to edit — but never the remaining count. Stock depth is the
 * owner's commercial information, and an error that reports it makes checkout a
 * free inventory API: send quantity 2, 4, 8… and the replies binary-search the
 * exact figure. "Sold out" is the one stock fact a customer is shown, because
 * they cannot act on the line without it.
 */
export function describeUnavailable(lines: UnavailableLine[]): string {
  if (lines.length === 0) {
    return "Sorry — an item in your cart just sold out. Please adjust your cart and try again.";
  }
  const parts = lines.map((line) => {
    const name = line.name ?? "An item in your cart";
    if (line.available === null) return `${name} is no longer available`;
    if (line.available === 0) return `${name} just sold out`;
    return `we can't ship that many of ${name} right now`;
  });
  return `${parts.join(". ")}. Please adjust your cart and try again.`;
}

// Hold every line of an order, all-or-nothing. Idempotent per order (a refresh
// or retry never double-holds). Returns ok:false with the unavailable lines
// when a tracked item is short. FAILS OPEN on any infra/migration error — the
// reservation is a guard, never a gate: a limiter outage must not block real
// customers (mirrors checkRateLimit's fail-open contract).
export async function reserveInventoryForOrder(
  orderId: string,
  items: OrderItemRef[],
  opts?: { expiresInMinutes?: number },
): Promise<ReserveResult> {
  const adjustments = planInventoryAdjustments(items);
  if (adjustments.length === 0) {
    return { ok: true, unavailable: [], degraded: false };
  }
  const minutes = opts?.expiresInMinutes ?? DEFAULT_RESERVATION_MINUTES;
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();

  const unavailable: ReserveResult["unavailable"] = [];
  for (const a of adjustments) {
    try {
      // Retried on an edge rejection: degrading here lets the checkout proceed
      // with NO hold on the stock it just sold.
      const { data, error } = await rpcWithAuthRetry<boolean>(async () =>
        supabaseAdmin.rpc("reserve_inventory", {
          p_slug: a.slug,
          p_variant_id: a.variantId,
          p_order_id: orderId,
          p_quantity: a.quantity,
          p_expires_at: expiresAt,
        }));
      if (error) {
        // Degrading is deliberate — a checkout must not die because the hold
        // could not be taken — but it must not be SILENT: with no hold the
        // oversell guard is off for this order, and until this line the only
        // record of that was the `degraded` flag nobody reads. Same reporter
        // (and the same persisted dedupe) as finalize/release/expire.
        await reportInventoryRpcFailure("reserve_inventory", orderId, error);
        return { ok: true, unavailable: [], degraded: true };
      }
      // A strict `false` means a tracked item lacked available stock. Anything
      // else (true, or null from an environment without the RPC) allows the line.
      if (data === false) {
        const detail = await readAvailable(a.slug, a.variantId);
        unavailable.push({ ...a, available: detail.available, name: detail.name });
      }
    } catch (error) {
      await reportInventoryRpcFailure("reserve_inventory", orderId, error);
      return { ok: true, unavailable: [], degraded: true };
    }
  }

  if (unavailable.length > 0) {
    // An order that can't fully reserve holds nothing — return what did get held.
    await releaseInventoryForOrder(orderId);
    return { ok: false, unavailable, degraded: false };
  }
  // Holds reduce what the next shopper can buy, and the storefront now reports
  // availability net of them, so the cached catalog has to be dropped too.
  invalidateCatalogCache();
  return { ok: true, unavailable: [], degraded: false };
}

/**
 * K-13. Every inventory RPC failure here was absorbed into a return value.
 *
 * `finalizeInventoryForOrder` returned `{ finalized: 0, degraded: true }` with no
 * log at all, and the caller's fallback then went to a function that does not
 * exist in production (G-04) — so a broken paid-path stock movement was
 * invisible from end to end. `expireStaleReservations` returned 0, which is
 * indistinguishable from "nothing was due", so the sweep reported a clean run
 * while every expired hold stayed on the shelf.
 *
 * The degradation is KEPT — a paid order must never be stranded by an inventory
 * RPC — but it stops being silent. This is the same trade the rate limiter makes
 * (K-15): fail soft, say so loudly.
 *
 * Throttled per RPC: an outage hits every order at once, and an alert each would
 * bury the signal.
 */
const INVENTORY_ALERT_THROTTLE_MS = 5 * 60_000;
const lastInventoryAlertAt = new Map<string, number>();

/** Breathing room for a momentary edge rejection, not a backoff schedule. */
const RPC_RETRY_DELAY_MS = 250;

/**
 * IS THIS A REJECTION THAT NEVER REACHED POSTGRES?
 *
 * Production rejects roughly 0.1% of this app's Supabase calls with a 401 whose
 * body reads "JWT issued at future" — 36 in 24 hours on 2026-08-27, spread
 * across nine different tables and RPCs, while the same RPC succeeded on the
 * ticks either side. Nothing retried, so one blip cost a whole half-hourly
 * sweep.
 *
 * THE NARROWNESS IS THE SAFETY ARGUMENT. A 401 is refused at the edge: the
 * statement never ran, so re-issuing it cannot double anything, whatever the
 * RPC does. That reasoning does NOT extend to an error raised by Postgres
 * itself — a statement timeout may have executed, wholly or partly, and this
 * module moves stock. Nor does it extend to a missing grant or a bad key, which
 * are permanent: retrying those only delays the alert that tells the operator
 * what to fix.
 *
 * So this matches the token, and nothing else.
 */
export function isTransientAuthRejection(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message ?? "");
  return /\bjwt\b/i.test(message);
}

/**
 * Run an inventory RPC, retrying ONCE if it was refused before it could run.
 *
 * One retry, not a loop: the observed failure is momentary, and a sweep that
 * hammers an edge which is already rejecting it makes an outage worse rather
 * than shorter. Two consecutive rejections are a real incident and alert.
 */
async function rpcWithAuthRetry<T>(
  run: () => Promise<{ data: T | null; error: unknown }>,
): Promise<{ data: T | null; error: unknown }> {
  const first = await run();
  if (!first.error || !isTransientAuthRejection(first.error)) return first;
  await new Promise((resolve) => setTimeout(resolve, RPC_RETRY_DELAY_MS));
  return run();
}

async function reportInventoryRpcFailure(rpc: string, orderId: string | null, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
  console.error("[inventory] RPC failed", rpc, orderId ?? "-", detail);

  const now = Date.now();
  if (now - (lastInventoryAlertAt.get(rpc) ?? 0) < INVENTORY_ALERT_THROTTLE_MS) return;
  lastInventoryAlertAt.set(rpc, now);
  try {
    await recordSystemAlert({
      type: "inventory_rpc_failed",
      severity: "critical",
      message: `${rpc} failed. Stock is not moving; counts on the storefront are no longer trustworthy.`,
      context: { rpc, orderId, detail },
      // THE MAP ALONE THROTTLED ALMOST NOTHING.
      //
      // It is module state, so it only spans one process. Of the three RPCs
      // that reach here, only releaseInventoryForOrder is called in a loop
      // within a single invocation (express-reconcile.ts's sweep);
      // finalizeInventoryForOrder fires once per payment webhook and
      // expireStaleReservations once per cron tick — i.e. always from a cold
      // Map on a fresh serverless invocation. Those two are the ones that alert
      // during an outage, and each one sent its own critical email.
      //
      // dedupeWindowMs is the persisted check, so the window survives the
      // invocation. It groups by alert TYPE where the Map groups per RPC — an
      // outage takes all three down together anyway, and a coarser window is
      // the point of a throttle. The Map is kept as a free fast path that saves
      // a query per iteration in the one genuinely looped caller.
      dedupeWindowMs: INVENTORY_ALERT_THROTTLE_MS,
    });
  } catch {
    // The console line above is the floor.
  }
}

/** Test-only: the throttle is module state and would leak between cases. */
export function __resetInventoryAlertThrottle(): void {
  lastInventoryAlertAt.clear();
}

/**
 * The holds the finalize RPC is ABOUT to turn into deductions.
 *
 * Read BEFORE the RPC runs, because that is the only moment they are
 * identifiable: afterwards their status is 'finalized' and they are
 * indistinguishable from lines a previous run already committed. Reading after
 * would attribute an earlier sale's units to this one on every replay.
 *
 * Best-effort. A failed read costs the ledger its rows, never the deduction —
 * the RPC that actually moves the stock does not depend on this.
 *
 * NULL, NOT AN EMPTY LIST, WHEN THE READ FAILED (F4). The caller now uses these
 * lines to decide which of the order's lines the finalize did NOT cover, and
 * "no holds existed" points at the opposite conclusion from "I could not find
 * out". Conflating them would let a failed read turn a fully-finalized order
 * into a full legacy decrement on top — every unit leaving the shelf twice.
 */
async function readPendingHolds(
  orderId: string,
): Promise<Array<{ slug: string; variantId: string | null; quantity: number }> | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory_reservations")
      .select("slug, variant_id, quantity")
      .eq("order_id", orderId)
      .eq("status", "active");
    if (error || !data) return null;
    return (data as Array<{ slug?: string | null; variant_id?: string | null; quantity?: number | null }>)
      .map((row) => ({
        slug: String(row.slug ?? ""),
        variantId: row.variant_id ? String(row.variant_id) : null,
        quantity: Math.trunc(Number(row.quantity ?? 0)),
      }))
      .filter((line) => line.slug.length > 0 && line.quantity > 0);
  } catch {
    return null;
  }
}

/**
 * How many of this order's holds are already deducted.
 *
 * Only meaningful AFTER the finalize RPC has errored — see
 * resolveFinalizeAfterError. A head count, so it costs one round trip and
 * cannot be truncated by a row cap.
 *
 * 0 on any failure, which is the safe direction: it keeps the caller on the
 * existing degraded path rather than letting a failed probe suppress a fallback
 * that is genuinely needed.
 */
async function countFinalizedHolds(orderId: string): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from("inventory_reservations")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId)
      .eq("status", "finalized");
    if (error) return 0;
    return Math.max(0, count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * WRITE DOWN THAT THE SHELF MOVED.
 *
 * `finalize_inventory_for_order` deducts stock inside Postgres and returns only
 * a count, so nothing about the movement reached `inventory_transactions` — the
 * admin's inventory history showed a shelf that only ever moved when a human
 * touched it. On 2026-08-27 the operator, seeing no sale row for the store's
 * first real customer order, decremented BAC Water a second time by hand. The
 * automatic deduction had already run.
 *
 * `quantity_before` is derived from the observed after-value and the units this
 * order took, rather than read separately before the RPC. That is deliberate:
 * it is the same convention the fallback path uses, and it cannot be skewed by
 * an admin edit landing between the two reads.
 */
async function recordFinalizedHolds(
  orderId: string,
  holds: Array<{ slug: string; variantId: string | null; quantity: number }>,
): Promise<void> {
  for (const hold of holds) {
    try {
      const { after, productId } = await readQuantityAfter(hold);
      await recordInventoryTransaction({
        productId: productId ?? hold.slug,
        doseId: hold.variantId,
        type: "order_completed",
        delta: -hold.quantity,
        quantityBefore: after === null ? null : after + hold.quantity,
        quantityAfter: after,
        reason: `Sold on ${orderId}`,
        actor: "payment_webhook",
        orderId,
      });
    } catch (error) {
      // Never fail a committed deduction over its audit row.
      console.error("Unable to record finalized inventory movement", orderId, hold.slug, error);
    }
  }
}

/** What the finalize actually managed to commit. */
export interface FinalizeInventoryResult {
  /** Lines the RPC deducted. */
  finalized: number;
  /** The RPC is unavailable — the caller must fall back for the whole order. */
  degraded: boolean;
  /**
   * WHICH lines were deducted, so the caller can decrement the rest (F4).
   *
   * `null` means the holds could not be enumerated, NOT that there were none.
   * A caller that cannot see the lines must fall back to the coarse rule
   * (decrement only when nothing finalized) rather than guess, because guessing
   * the wrong way here decrements paid stock twice.
   */
  finalizedLines: Array<{ slug: string; variantId: string | null; quantity: number }> | null;
}

/**
 * DID THE RPC FAIL, OR DID ONLY ITS ANSWER GET LOST?
 *
 * Both failure paths below used to answer `{ finalized: 0, degraded: true }`
 * without looking, which conflates two opposite outcomes. `finalize_inventory_
 * for_order` commits inside Postgres; a transport or client error raised AFTER
 * that commit — a dropped socket, a timeout on the response, the 401 lane
 * isTransientAuthRejection deliberately does NOT retry — is indistinguishable at
 * this call site from an RPC that never ran.
 *
 * It matters because `degraded: true` is exactly what makes both callers run the
 * legacy decrement (payment-webhook.ts, card and manual lanes), with no check
 * that the holds are already finalized. So a lost response took every unit off
 * the shelf a second time.
 *
 * The reservations rows are the record of what Postgres actually did, so they
 * are asked. A non-zero count means the deduction is committed, and this returns
 * what the success path would have returned — same finalizedLines guard, same
 * ledger rows, same cache invalidation — so the caller skips the second
 * decrement. Zero (or a probe that itself fails) keeps today's degraded answer.
 *
 * The alert still fires either way: the RPC edge really did fail, and the
 * operator should hear about it even when the data survived.
 */
async function resolveFinalizeAfterError(
  orderId: string,
  pendingHolds: Array<{ slug: string; variantId: string | null; quantity: number }> | null,
): Promise<FinalizeInventoryResult> {
  const committed = await countFinalizedHolds(orderId);
  if (committed <= 0) {
    return { finalized: 0, degraded: true, finalizedLines: null };
  }
  invalidateCatalogCache();
  if (pendingHolds) {
    await recordFinalizedHolds(orderId, pendingHolds);
  }
  const finalizedLines = pendingHolds && pendingHolds.length >= committed ? pendingHolds : null;
  return { finalized: committed, degraded: false, finalizedLines };
}

// A verified payment permanently deducts every active hold for the order.
// Idempotent (a replay finds them already finalized). `finalized` is the number
// of lines deducted; `degraded` means the RPC is unavailable so the caller must
// fall back to the legacy decrement.
//
// F4. A RESERVATION CAN BE PARTIAL, AND THIS IS WHERE THAT BECOMES VISIBLE.
// reserveInventoryForOrder holds line by line and returns `degraded: true` the
// moment one line's RPC fails — after the earlier lines are already held. So an
// order can arrive here with a hold on line 1 and none on line 2, and the count
// alone cannot say which. `finalizedLines` is that missing fact; the caller
// diffs it against the order's lines and decrements only what never moved.
export async function finalizeInventoryForOrder(orderId: string): Promise<FinalizeInventoryResult> {
  // Captured before the RPC — see readPendingHolds. On a replay this is empty,
  // which is exactly why a replay adds no ledger rows.
  const pendingHolds = await readPendingHolds(orderId);
  try {
    const { data, error } = await rpcWithAuthRetry<number>(async () =>
      supabaseAdmin.rpc("finalize_inventory_for_order", { p_order_id: orderId }));
    if (error) {
      await reportInventoryRpcFailure("finalize_inventory_for_order", orderId, error);
      return resolveFinalizeAfterError(orderId, pendingHolds);
    }
    invalidateCatalogCache();
    const finalized = Number(data ?? 0);
    // Only when the RPC actually moved something. Recording a movement that did
    // not happen is the same class of error as not recording one that did, and
    // the caller runs the fallback decrement on `finalized === 0` — which
    // writes its own rows.
    if (finalized > 0 && pendingHolds) {
      await recordFinalizedHolds(orderId, pendingHolds);
    }
    // A count the holds cannot account for is not a usable diff: the RPC moved
    // more lines than this read can name, so the caller must not treat the
    // remainder as unmoved.
    const finalizedLines = pendingHolds && pendingHolds.length >= finalized ? pendingHolds : null;
    return { finalized, degraded: false, finalizedLines };
  } catch (error) {
    await reportInventoryRpcFailure("finalize_inventory_for_order", orderId, error);
    return resolveFinalizeAfterError(orderId, pendingHolds);
  }
}

// Return every active hold for the order (failed/canceled/abandoned checkout).
// Idempotent and best-effort — a release failure never blocks the caller.
//
// P2-5. THE ERROR WAS NEVER LOOKED AT. This awaited the rpc and guarded it with
// try/catch alone — but supabase-js does not throw on a rejected request, it
// RESOLVES with `{ data: null, error }`. So the failure this module cares most
// about went past the catch untouched: production rejects roughly 0.1% of this
// app's Supabase calls with a 401 (see isTransientAuthRejection), and every one
// of them left a hold sitting on the shelf while this function returned as if it
// had released it. `inventory_rpc_failed` could not fire for release at all —
// the alert existed, but only for the throw path, which is the rare one. A
// stranded hold makes stock unsellable until the expiry sweep reclaims it, and
// for an order cancelled before payment there is no sweep window short enough
// for the shopper who wanted that unit.
//
// Now it observes the error, retries the one narrow class of rejection that
// provably never reached Postgres (identical to finalize and the sweep), and
// alerts when the release really did not happen. Still best-effort for the
// caller: the posture is fail-soft-but-loud, not fail-hard.
export async function releaseInventoryForOrder(orderId: string): Promise<void> {
  try {
    const { error } = await rpcWithAuthRetry(async () =>
      supabaseAdmin.rpc("release_inventory_for_order", { p_order_id: orderId }));
    if (error) {
      await reportInventoryRpcFailure("release_inventory_for_order", orderId, error);
      return;
    }
    invalidateCatalogCache();
  } catch (error) {
    await reportInventoryRpcFailure("release_inventory_for_order", orderId, error);
  }
}

// Release every hold past its expiry (called by the scheduled sweep). Returns
// the number reclaimed.
export async function expireStaleReservations(): Promise<number> {
  try {
    const { data, error } = await rpcWithAuthRetry<number>(async () =>
      supabaseAdmin.rpc("expire_stale_reservations", {}));
    if (error) {
      // Returning 0 is indistinguishable from "nothing was due", so the sweep
      // reports a clean run while every expired hold stays on the shelf.
      await reportInventoryRpcFailure("expire_stale_reservations", null, error);
      return 0;
    }
    // Reclaimed holds put units back on sale — publish that immediately rather
    // than leaving them looking unavailable until the TTL lapses.
    if (Number(data ?? 0) > 0) invalidateCatalogCache();
    return Number(data ?? 0);
  } catch (error) {
    await reportInventoryRpcFailure("expire_stale_reservations", null, error);
    return 0;
  }
}
