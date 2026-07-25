import { supabaseAdmin } from "@/lib/supabase-server";
import { planInventoryAdjustments, type OrderItemRef } from "@/lib/inventory-fulfillment";

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

export interface ReserveResult {
  ok: boolean;
  unavailable: Array<{ slug: string; variantId: string | null; quantity: number }>;
  degraded: boolean;
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
      const { data, error } = await supabaseAdmin.rpc("reserve_inventory", {
        p_slug: a.slug,
        p_variant_id: a.variantId,
        p_order_id: orderId,
        p_quantity: a.quantity,
        p_expires_at: expiresAt,
      });
      if (error) {
        return { ok: true, unavailable: [], degraded: true };
      }
      // A strict `false` means a tracked item lacked available stock. Anything
      // else (true, or null from an environment without the RPC) allows the line.
      if (data === false) {
        unavailable.push(a);
      }
    } catch {
      return { ok: true, unavailable: [], degraded: true };
    }
  }

  if (unavailable.length > 0) {
    // An order that can't fully reserve holds nothing — return what did get held.
    await releaseInventoryForOrder(orderId);
    return { ok: false, unavailable, degraded: false };
  }
  return { ok: true, unavailable: [], degraded: false };
}

// A verified payment permanently deducts every active hold for the order.
// Idempotent (a replay finds them already finalized). `finalized` is the number
// of lines deducted; `degraded` means the RPC is unavailable so the caller must
// fall back to the legacy decrement.
export async function finalizeInventoryForOrder(orderId: string): Promise<{ finalized: number; degraded: boolean }> {
  try {
    const { data, error } = await supabaseAdmin.rpc("finalize_inventory_for_order", { p_order_id: orderId });
    if (error) return { finalized: 0, degraded: true };
    return { finalized: Number(data ?? 0), degraded: false };
  } catch {
    return { finalized: 0, degraded: true };
  }
}

// Return every active hold for the order (failed/canceled/abandoned checkout).
// Idempotent and best-effort — a release failure never blocks the caller.
export async function releaseInventoryForOrder(orderId: string): Promise<void> {
  try {
    await supabaseAdmin.rpc("release_inventory_for_order", { p_order_id: orderId });
  } catch (error) {
    console.error("Unable to release inventory reservation for order", orderId, error);
  }
}

// Release every hold past its expiry (called by the scheduled sweep). Returns
// the number reclaimed.
export async function expireStaleReservations(): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin.rpc("expire_stale_reservations", {});
    if (error) return 0;
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}
