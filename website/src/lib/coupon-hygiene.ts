import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// GENERATED COUPONS DO NOT DIE ON THEIR OWN.
//
// Cart recovery mints a single-use code per abandoned cart with `ends_at` a
// few days out. The checkout honours `ends_at`, so an expired code cannot be
// redeemed — but nothing ever flipped `active` off. Production carried 339
// cart-recovery coupons, every one expired, every one still `active = true`:
// the admin coupon list, the "active coupons" counts and every reader that
// filters on `active` alone saw hundreds of dead codes as live. The sweep
// below closes them once they are past their end, and the abandoned carts
// that fed them once the recovery window has closed, so neither set grows
// without bound again.
// ---------------------------------------------------------------------------

/** Sources of codes the system mints on its own (never typed by an operator). */
export const GENERATED_COUPON_SOURCES = ["cart_recovery"] as const;

/** The last recovery stage closes at 96h; a cart older than this is finished. */
export const ABANDONED_CART_EXPIRY_MS = 96 * 60 * 60 * 1000;

export type CouponHygieneResult = {
  couponsDeactivated: number;
  cartsExpired: number;
};

/**
 * Flip `active` off for generated coupons whose `ends_at` has passed, and mark
 * abandoned carts still `active` past the recovery window as `expired`.
 *
 * Idempotent: a second run in the same tick finds nothing left to touch.
 * Operator-created coupons are never touched — an expired manual code is the
 * operator's to reactivate with a new date.
 */
export async function runCouponHygiene(now: Date = new Date()): Promise<CouponHygieneResult> {
  const nowIso = now.toISOString();

  const { data: coupons, error: couponError } = await supabaseAdmin
    .from("coupons")
    .update({ active: false })
    .in("source", [...GENERATED_COUPON_SOURCES])
    .eq("active", true)
    .not("ends_at", "is", null)
    .lt("ends_at", nowIso)
    .select("id");
  if (couponError) throw couponError;

  const cutoff = new Date(now.getTime() - ABANDONED_CART_EXPIRY_MS).toISOString();
  const { data: carts, error: cartError } = await supabaseAdmin
    .from("abandoned_carts")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("last_updated_at", cutoff)
    .select("id");
  if (cartError) throw cartError;

  return {
    couponsDeactivated: (coupons ?? []).length,
    cartsExpired: (carts ?? []).length,
  };
}
