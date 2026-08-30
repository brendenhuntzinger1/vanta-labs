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
  // `head: true` WOULD BE THE OBVIOUS CHOICE HERE AND IT IS THE WRONG ONE.
  //
  // supabase-js turns head:true into an HTTP HEAD request, and a HEAD response
  // carries no body — so PostgREST's error payload, and with it the `42703`
  // that says "this column does not exist", never reaches the client. The error
  // arrives as `{ message: '' }` with no code, indistinguishable from a network
  // blip, and the missing-migration guard below cannot fire.
  //
  // Caught against a real PostgREST, not in a unit test: the mock returned a
  // structured error, the wire did not. `limit(1)` keeps the body to a single
  // row while leaving the count in Content-Range and the error legible.
  let query = supabaseAdmin
    .from("orders")
    .select("id", { count: "exact" })
    .eq(PROMOTION_COLUMN, promotionId)
    .in("payment_status", REDEEMED_STATUSES as unknown as string[])
    .limit(1);

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

export interface PromotionUsageResult {
  /** Promotions that have hit a limit and may no longer be applied. */
  exhaustedIds: string[];
  /**
   * False when `orders.promotion_id` does not exist, so no usage limit in this
   * store can be counted at all.
   *
   * THIS IS THE DIFFERENCE BETWEEN A MISSING MIGRATION AND A BAD MINUTE, AND
   * THE TWO GET OPPOSITE ANSWERS.
   *
   * A transient count failure — a statement timeout, an RLS refusal — is
   * handled by leaving the promotion alone: it self-heals, and dropping a
   * promotion the cart already previewed turns a database blip into a refused
   * sale ("Altered total detected"). Over-running a cap by a few orders during
   * an incident is the cheaper mistake, and it is logged.
   *
   * A MISSING COLUMN IS NOT A BAD MINUTE. It does not heal, it lasts until
   * someone runs the migration, and for its whole duration every "limit 100" /
   * "one per customer" promotion in the store would be unlimited — silently,
   * because nothing about the storefront looks wrong. So a promotion that
   * carries a limit is NOT APPLIED while its limit cannot be counted. A
   * promotion with no limits is unaffected and runs normally.
   *
   * Both sides see the same list (getApplicableBxgyPromotions is what
   * /api/catalog/promotions publishes and what quote-order prices against), so
   * this withholds a discount — it never blocks a checkout.
   */
  limitsEnforceable: boolean;
}

/**
 * The promotions that may no longer be applied, because a limit is reached,
 * plus whether limits can be counted at all.
 *
 * See PromotionUsageResult.limitsEnforceable for why a count that CANNOT RUN
 * and a count that HAS NOT YET RUN are treated differently.
 */
export async function getPromotionUsage(
  promotions: readonly BxgyPromotion[],
  context: PromotionUsageContext = {},
): Promise<PromotionUsageResult> {
  const email = context.customerEmail?.trim().toLowerCase();
  const exhaustedIds: string[] = [];

  await Promise.all(promotions.map(async (promotion) => {
    if (promotion.maxRedemptions !== null) {
      const used = await countRedemptions(promotion.id);
      if (used !== null && used >= promotion.maxRedemptions) {
        exhaustedIds.push(promotion.id);
        return;
      }
    }
    if (promotion.perCustomerLimit !== null && email) {
      const used = await countRedemptions(promotion.id, email);
      if (used !== null && used >= promotion.perCustomerLimit) {
        exhaustedIds.push(promotion.id);
      }
    }
  }));

  return { exhaustedIds, limitsEnforceable: !promotionColumnMissing };
}

/** Backwards-compatible view for callers that only need the exhausted ids. */
export async function getExhaustedPromotionIds(
  promotions: readonly BxgyPromotion[],
  context: PromotionUsageContext = {},
): Promise<string[]> {
  return (await getPromotionUsage(promotions, context)).exhaustedIds;
}

/** Does this promotion depend on a usage limit that has to be counted? */
export function hasUsageLimit(promotion: BxgyPromotion): boolean {
  return promotion.maxRedemptions !== null || promotion.perCustomerLimit !== null;
}

/**
 * Whether the store can count redemptions at all — i.e. whether
 * orders.promotion_id exists.
 *
 * Answers from the memoised result once a read has proved it either way, and
 * probes with a single cheap count otherwise. The promotion centre shows this
 * so an admin who sets a limit and sees the promotion refuse to run is told
 * why, rather than filing it as a bug.
 */
export async function areUsageLimitsEnforceable(): Promise<boolean> {
  if (promotionColumnMissing) return false;
  await countRedemptions("__migration_probe__");
  return !promotionColumnMissing;
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

  const usage = await getPromotionUsage(live, context);
  const blocked = new Set(usage.exhaustedIds);

  if (!usage.limitsEnforceable) {
    // The migration is not applied. Withhold every promotion whose limit cannot
    // be counted rather than running it as if it were unlimited — see
    // PromotionUsageResult.limitsEnforceable.
    for (const promotion of live) {
      if (hasUsageLimit(promotion)) blocked.add(promotion.id);
    }
  }

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
