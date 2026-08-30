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
// USAGE LIMITS ARE CLAIMED ATOMICALLY, AND COUNTED FROM ORDER STATUS.
//
// Two halves, and both matter:
//
//   COUNTING. A counter that is incremented at checkout has to be decremented
//   on refund, on cancellation, on a failed capture and on every path anyone
//   adds later; the day one of those is missed the promotion is permanently a
//   redemption short of its limit with nothing to point at. A claim's liveness
//   is DERIVED from its order's payment status instead, so refunds and
//   cancellations release it with no code to remember.
//
//   ENFORCING. Counting and then inserting is a race: two shoppers reaching the
//   last redemption together both read "one left". The claim is therefore taken
//   in a single locked function (bxgy_claim_redemption) before the order is
//   written — see src/lib/sql/bxgy-redemption-claims.sql for the lock and why
//   it cannot deadlock.
//
// Only promotions that actually HAVE a limit are ever counted or claimed.
//
// ---------------------------------------------------------------------------
// WHAT HAPPENS WHEN THE DATABASE IS UNAVAILABLE — the complete list.
//
//   1. THE MIGRATION IS NOT APPLIED (structural, permanent).
//      Every limited promotion is WITHHELD: it is absent from the list the cart
//      is given and from the list the checkout prices against, so it simply does
//      not run. Unlimited promotions are unaffected. The promotion centre shows
//      a banner and marks those promotions "Blocked". A limit that cannot be
//      enforced must never look enforced. Logged once per process.
//
//   2. THE COUNT FAILS AT QUOTE TIME (transient — timeout, RLS, blip).
//      The promotion KEEPS RUNNING and may exceed its cap for the duration.
//      Deliberate, and unchanged by the move to atomic claims: the cart and the
//      checkout resolve the same list, so withholding on a transient failure
//      would drop a promotion the cart already previewed, push the server total
//      above the shopper's claimed one, and the altered-total guard would refuse
//      the sale. Over-running a cap during an incident costs the margin on a few
//      orders; failing closed costs every order placed during it. Logged.
//
//   3. THE CLAIM FAILS AT ORDER TIME (transient).
//      The order PROCEEDS. Same rule as (2) and for the same reason — a
//      reservation that could not be taken must not refuse a sale that was
//      priced correctly moments earlier. The exposure is narrower than (2): the
//      promotion was only offered because the count succeeded at quote time.
//      Logged.
//
//   4. THE CLAIM ANSWERS FALSE (the database is fine; the limit is reached).
//      The order is REFUSED with the same sentence the altered-total guard uses,
//      because it is the same situation from the shopper's side: the price they
//      were quoted is no longer available and the page must re-price. This is
//      the only case that stops a checkout, and it is the correct one.
//
// So: a structural failure withholds the promotion, a transient failure lets it
// through, and only a genuinely exhausted limit refuses an order.
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
 * Order states that consume a redemption for good.
 *
 * `partially_refunded` still counts: the sale happened, the promotion was
 * honoured, and part of the money was returned. `refunded`, `canceled`,
 * `cancelled` and `payment_failed` do not — an order that never became a sale,
 * or stopped being one, gives its redemption back. `pending_payment` counts
 * only while its hold is live (see CLAIM_HOLD_SECONDS).
 *
 * Kept in step with bxgy_count_redemptions, which is where the rule is
 * ENFORCED; a structural test asserts the two lists match.
 */
export const REDEEMED_STATUSES = ["paid", "partially_refunded"] as const;

/**
 * How long a claim holds a redemption before the order is paid.
 *
 * Matched to the inventory hold for the same order, deliberately: a checkout
 * that still holds stock must still hold its promotion slot, or the two expire
 * at different moments and a shopper can pay for an order whose promotion has
 * been given away. Manual payment methods hold stock for a day, so they hold a
 * redemption for a day too.
 */
export const CLAIM_HOLD_SECONDS = 15 * 60;
export const MANUAL_CLAIM_HOLD_SECONDS = 24 * 60 * 60;

/**
 * True once a read has proved the atomic layer is not installed, for the life
 * of this process.
 *
 * The migration is separate from the deploy, so there is a window in which the
 * code is live and the function is not. Remembering the answer keeps that
 * window from costing one failed call per limited promotion per checkout.
 */
let atomicLayerMissing = false;

function isMissingObjectError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42883 undefined_function / 42P01 undefined_table from Postgres; PGRST202
  // is PostgREST's "no function matches" for an RPC it cannot find in the
  // schema cache. The message check is a last resort only.
  return error.code === "42883"
    || error.code === "42P01"
    || error.code === "PGRST202"
    || Boolean(error.message && /bxgy_(claim|count|release)_redemption|promotion_redemption_claims/i.test(error.message));
}

function noteMissingAtomicLayer(where: string): void {
  if (!atomicLayerMissing) {
    atomicLayerMissing = true;
    console.warn(
      `[bxgy] the atomic redemption layer is missing (${where}). Promotions carrying a usage limit will NOT run `
      + "until src/lib/sql/bxgy-redemption-claims.sql is applied.",
    );
  }
}

/**
 * Live redemptions of one promotion, optionally for one customer.
 *
 * Delegates to bxgy_count_redemptions so the count the cart is shown and the
 * count the claim enforces are the same SQL, not two implementations that agree
 * on the day they were written. Returns null when the count could not be taken.
 */
async function countRedemptions(
  promotionId: string,
  customerEmail?: string,
  holdSeconds: number = CLAIM_HOLD_SECONDS,
): Promise<number | null> {
  if (atomicLayerMissing) return null;

  const { data, error } = await supabaseAdmin.rpc("bxgy_count_redemptions", {
    p_promotion_id: promotionId,
    p_customer_email: customerEmail ? customerEmail.trim().toLowerCase() : null,
    p_hold_seconds: holdSeconds,
  });

  if (error) {
    if (isMissingObjectError(error)) {
      noteMissingAtomicLayer("bxgy_count_redemptions");
      return null;
    }
    console.error(`Unable to count redemptions for promotion ${promotionId}`, error);
    return null;
  }
  const count = Number(data);
  return Number.isFinite(count) ? count : null;
}

export interface ClaimRedemptionInput {
  promotionId: string;
  orderId: string;
  customerEmail?: string | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  /** Use MANUAL_CLAIM_HOLD_SECONDS for a manual payment method. */
  holdSeconds?: number;
}

/**
 * Reserve one redemption for an order, atomically.
 *
 * Call this BEFORE the order row is written, and do not write the order if it
 * answers false — the promotion is fully claimed and the price the shopper was
 * quoted is no longer available.
 *
 * Returns false only when a limit is genuinely reached. A failure to reach the
 * database answers TRUE, matching how a failed count is treated: an unreadable
 * limit must not refuse a sale that was priced correctly. Both are logged.
 */
export async function claimPromotionRedemption(input: ClaimRedemptionInput): Promise<boolean> {
  if (atomicLayerMissing) return true;

  const { data, error } = await supabaseAdmin.rpc("bxgy_claim_redemption", {
    p_promotion_id: input.promotionId,
    p_order_id: input.orderId,
    p_customer_email: input.customerEmail ? input.customerEmail.trim().toLowerCase() : null,
    p_max_redemptions: input.maxRedemptions,
    p_per_customer_limit: input.perCustomerLimit,
    p_hold_seconds: input.holdSeconds ?? CLAIM_HOLD_SECONDS,
  });

  if (error) {
    if (isMissingObjectError(error)) {
      noteMissingAtomicLayer("bxgy_claim_redemption");
      return true;
    }
    console.error(`Unable to claim a redemption for promotion ${input.promotionId}`, error);
    return true;
  }
  return data !== false;
}

/**
 * Hand a claimed redemption back when the checkout failed after claiming it.
 *
 * Best effort and never throws: an unused hold expires on its own, so this only
 * returns the slot in seconds rather than minutes. Refuses to release a claim
 * whose order actually became a sale (enforced in SQL, not here).
 */
export async function releasePromotionRedemption(orderId: string): Promise<void> {
  if (atomicLayerMissing) return;
  try {
    const { error } = await supabaseAdmin.rpc("bxgy_release_redemption", { p_order_id: orderId });
    if (error && !isMissingObjectError(error)) {
      console.error(`Unable to release the redemption claim for order ${orderId}`, error);
    }
  } catch (error) {
    console.error(`Unable to release the redemption claim for order ${orderId}`, error);
  }
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

export interface PromotionUsageContext {
  /** Lower-cased at the call site or here; absent for an anonymous cart. */
  customerEmail?: string;
}

export interface PromotionUsageResult {
  /** Promotions that have hit a limit and may no longer be applied. */
  exhaustedIds: string[];
  /**
   * False when the atomic redemption layer
   * (`bxgy-redemption-claims.sql` — the claim table and its functions) is not
   * installed, so no usage limit in this store can be counted or enforced.
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
   * A MISSING MIGRATION IS NOT A BAD MINUTE. It does not heal, it lasts until
   * someone runs it, and for its whole duration every "limit 100" /
   * "one per customer" promotion in the store would be unlimited — silently,
   * because nothing about the storefront looks wrong. So a promotion that
   * carries a limit is NOT APPLIED while its limit cannot be enforced. A
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

  return { exhaustedIds, limitsEnforceable: !atomicLayerMissing };
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
  if (atomicLayerMissing) return false;
  await countRedemptions("__migration_probe__");
  return !atomicLayerMissing;
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
