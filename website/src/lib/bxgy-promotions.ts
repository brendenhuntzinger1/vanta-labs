// ---------------------------------------------------------------------------
// THE SERVER HALF OF THE PROMOTION CENTRE.
//
// bxgy-engine.ts prices a promotion; bxgy-config.ts reads one back out of
// storage. This module is the only one that talks to the database: it loads the
// configured promotions through the existing admin control values, counts how
// many times each has been redeemed, and answers the one question the pure
// modules cannot — "which promotions may still be used, by this shopper, right
// now".
//
// USAGE LIMITS ARE COUNTED FROM ORDERS, NOT FROM A COUNTER COLUMN.
//
// A counter that is incremented at checkout has to be decremented on refund, on
// cancellation, on a failed capture and on every path anyone adds later; the
// day one of those is missed the promotion is permanently a redemption short of
// its limit with nothing to point at. Counting `orders` rows carrying the
// promotion id gives refunds and cancellations for free: an order that stops
// being a sale stops being a redemption, because REDEEMED_STATUSES no longer
// matches it. It costs one indexed COUNT per limited promotion per quote, which
// is why only promotions that actually HAVE a limit are ever counted.
// ---------------------------------------------------------------------------

import { supabaseAdmin } from "@/lib/supabase-server";
import { getHomepageControlConfig, upsertControlValue } from "@/lib/admin-control";
import {
  BXGY_CONTROL_KEY,
  BXGY_CONTROL_SECTION,
  applyLegacyPromotionFlags,
  defaultBxgyPromotions,
  legacyFlagKeyFor,
  serializeBxgyPromotions,
} from "@/lib/bxgy-config";
import { liveBxgyPromotions, type BxgyPromotion } from "@/lib/bxgy-engine";

/**
 * Order states that consume a redemption.
 *
 * `partially_refunded` still counts: the sale happened, the promotion was
 * honoured, and part of the money was returned. `refunded`, `canceled`,
 * `cancelled`, `payment_failed` and `pending_payment` do not — an order that
 * never became a sale, or stopped being one, gives its redemption back.
 */
export const REDEEMED_STATUSES = ["paid", "partially_refunded"] as const;

/** Column that records which promotion priced an order (bxgy-promotions.sql). */
const PROMOTION_COLUMN = "promotion_id";

/**
 * True once a read has proved `orders.promotion_id` is missing, for the life of
 * this process.
 *
 * The migration is separate from the deploy, so there is a window in which the
 * code is live and the column is not. Remembering the answer keeps that window
 * from costing one failed count per limited promotion per checkout.
 */
let promotionColumnMissing = false;

function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42703 = undefined_column. PostgREST also answers PGRST204 for an unknown
  // column in a payload, and the message is checked as a last resort because a
  // pooled connection can surface either.
  return error.code === "42703"
    || error.code === "PGRST204"
    || Boolean(error.message && /promotion_id/i.test(error.message) && /column|schema cache/i.test(error.message));
}

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

/**
 * Every configured promotion, with the two legacy control-centre switches
 * reconciled on top.
 *
 * Never throws: a promotion-config read must not be able to fail a checkout.
 * On a failed read the store behaves exactly as it does with no promotions
 * configured — none apply — which is the same posture /api/catalog/promotions
 * already takes for the rest of the promotion config.
 */
export async function getBxgyPromotions(): Promise<BxgyPromotion[]> {
  try {
    const config = await getHomepageControlConfig();
    // The list is resolved inside getHomepageControlConfig, so the checkout
    // reads the promotion config in the same pass it already reads bundle
    // pricing and the legacy switches. The fallback covers a config that
    // predates the field (or a stubbed one): the built-ins, off, with the two
    // legacy switches still honoured — which is exactly this store's behaviour
    // before the promotion centre existed.
    return config.bxgyPromotions ?? applyLegacyPromotionFlags(defaultBxgyPromotions(), {
      buy3Get1Enabled: Boolean(config.promoBuy3Get1Enabled),
      buy2Get1HalfEnabled: Boolean(config.promoBuy2Get1HalfEnabled),
    });
  } catch (error) {
    console.error("Unable to load Buy X Get Y promotions", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// USAGE LIMITS
// ---------------------------------------------------------------------------

async function countRedemptions(promotionId: string, customerEmail?: string): Promise<number | null> {
  if (promotionColumnMissing) return null;
  let query = supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq(PROMOTION_COLUMN, promotionId)
    .in("payment_status", REDEEMED_STATUSES as unknown as string[]);

  if (customerEmail) {
    query = query.eq("customer_email", customerEmail.trim().toLowerCase());
  }

  const { count, error } = await query;
  if (error) {
    if (isMissingColumnError(error)) {
      promotionColumnMissing = true;
      console.warn("orders.promotion_id is missing — promotion usage limits are not being enforced. Apply src/lib/sql/bxgy-promotions.sql.");
      return null;
    }
    console.error(`Unable to count redemptions for promotion ${promotionId}`, error);
    return null;
  }
  return count ?? 0;
}

export interface PromotionUsageContext {
  /** Lower-cased at the call site or here; absent for an anonymous cart. */
  customerEmail?: string;
}

/**
 * The promotions that may no longer be applied, because a limit is reached.
 *
 * A COUNT THAT CANNOT BE READ DOES NOT DISABLE A PROMOTION. That is a
 * deliberate, and the less obvious, choice. The client cart prices the same
 * promotions from the same config, and payment-service rejects any order whose
 * claimed total is below the server's — so a server that quietly drops a
 * promotion the cart showed does not under-charge, it BLOCKS THE SALE with
 * "Altered total detected". Over-running a redemption cap during a database
 * incident costs the margin on a few orders; failing closed costs every order
 * placed during it. The failure is logged either way.
 */
export async function getExhaustedPromotionIds(
  promotions: readonly BxgyPromotion[],
  context: PromotionUsageContext = {},
): Promise<string[]> {
  const email = context.customerEmail?.trim().toLowerCase();
  const exhausted: string[] = [];

  await Promise.all(promotions.map(async (promotion) => {
    if (promotion.maxRedemptions !== null) {
      const used = await countRedemptions(promotion.id);
      if (used !== null && used >= promotion.maxRedemptions) {
        exhausted.push(promotion.id);
        return;
      }
    }
    if (promotion.perCustomerLimit !== null && email) {
      const used = await countRedemptions(promotion.id, email);
      if (used !== null && used >= promotion.perCustomerLimit) {
        exhausted.push(promotion.id);
      }
    }
  }));

  return exhausted;
}

/**
 * The promotions a shopper may actually earn right now: switched on, inside
 * their schedule, and not used up.
 *
 * This is what the checkout prices against and what /api/catalog/promotions
 * publishes to the cart, so the two cannot disagree about which promotions
 * exist. They can still disagree about a store-wide cap that fills between the
 * cart loading and the order being placed — a race no shared function can close
 * — and that lands as the existing altered-total error rather than a silent
 * under-charge.
 */
export interface ApplicablePromotionOptions {
  /** Already-loaded promotion list, to avoid a second config read. */
  promotions?: readonly BxgyPromotion[];
  now?: Date;
}

export async function getApplicableBxgyPromotions(
  context: PromotionUsageContext = {},
  options: ApplicablePromotionOptions = {},
): Promise<BxgyPromotion[]> {
  const now = options.now ?? new Date();
  const configured = options.promotions ?? await getBxgyPromotions();
  const live = liveBxgyPromotions(configured, { now });
  if (live.length === 0) return [];
  const exhausted = await getExhaustedPromotionIds(live, context);
  const blocked = new Set(exhausted);
  return live.filter((promotion) => !blocked.has(promotion.id));
}

// ---------------------------------------------------------------------------
// SAVING (admin)
// ---------------------------------------------------------------------------

export interface SavePromotionsMeta {
  actorUsername: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Persist the promotion list, and keep the two legacy switches in step.
 *
 * The legacy keys are written from the promotion array rather than the other
 * way round, so the promotion centre is the thing an admin edits and the older
 * control-centre checkboxes simply follow. Writing them in the same request is
 * what keeps the reconciliation in applyLegacyPromotionFlags from ever having
 * anything to correct.
 */
export async function saveBxgyPromotions(
  promotions: BxgyPromotion[],
  meta: SavePromotionsMeta,
): Promise<void> {
  await upsertControlValue({
    section: BXGY_CONTROL_SECTION,
    key: BXGY_CONTROL_KEY,
    value: serializeBxgyPromotions(promotions),
    ...meta,
  });

  for (const promotion of promotions) {
    const legacyKey = legacyFlagKeyFor(promotion.id);
    if (!legacyKey) continue;
    await upsertControlValue({
      section: BXGY_CONTROL_SECTION,
      key: legacyKey,
      value: promotion.enabled,
      ...meta,
    });
  }
}
