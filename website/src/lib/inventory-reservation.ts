import { supabaseAdmin } from "@/lib/supabase-server";
import { planInventoryAdjustments, type OrderItemRef } from "@/lib/inventory-fulfillment";
import { invalidateCatalogCache } from "@/lib/catalog-cache";

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
        const detail = await readAvailable(a.slug, a.variantId);
        unavailable.push({ ...a, available: detail.available, name: detail.name });
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
  // Holds reduce what the next shopper can buy, and the storefront now reports
  // availability net of them, so the cached catalog has to be dropped too.
  invalidateCatalogCache();
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
    invalidateCatalogCache();
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
    invalidateCatalogCache();
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
    // Reclaimed holds put units back on sale — publish that immediately rather
    // than leaving them looking unavailable until the TTL lapses.
    if (Number(data ?? 0) > 0) invalidateCatalogCache();
    return Number(data ?? 0);
  } catch {
    return 0;
  }
}
