import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";

import type { ContributionBreakdown } from "@/lib/benefits/contribution";

// ---------------------------------------------------------------------------
// PERSISTING THE CONTRIBUTION SNAPSHOT.
//
// THE RULE THIS FILE EXISTS TO KEEP: A SALE IS NEVER UNDONE BY A REPORTING
// FAILURE. The order is already in the database by the time anything here runs.
// Nothing below throws, nothing below returns a value the caller branches on to
// refuse a sale, and every failure path ends in an alert and a `return`.
//
// That is the same posture `alertIfBelowProfitFloor` takes, and it is called
// from the same place for the same reason: `insertOrderRow` is where both live
// order lanes land, so it is the one point where a per-order fact can be
// written exactly once, with an order id to attach it to.
//
// WHAT IS STRUCTURALLY EXCLUDED, rather than excluded by a condition someone
// has to remember:
//
//   Membership orders   `membership-billing.ts:599` writes its own row and
//                       never calls insertOrderRow. A subscription has no
//                       merchandise, no COGS and never ships.
//   Replacement orders  `admin-replacements.ts:172` likewise. A reship is not a
//                       sale and carries no marketing attribution.
//
// Neither lane can reach this function, so neither can grow a snapshot by
// accident. contribution-store.test.ts pins that they do not call it.
//
// EXACTLY ONCE, TWICE OVER. `order_contribution.order_id` is the primary key,
// so a second write for the same order is impossible at the database. And
// `insertOrderRow` returns early on a duplicate (Postgres 23505) BEFORE
// reaching this call, so a retried checkout never even attempts one. The
// `ignoreDuplicates` upsert below is the third belt: if a snapshot somehow
// already exists, the first one — the quote-time truth — stands, and the retry
// is a no-op rather than an error or an overwrite.
// ---------------------------------------------------------------------------

/**
 * Attribution for a contribution snapshot.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY UNKNOWN IS NULL. An unattributed order
 * credited to a channel would let a campaign claim revenue it did not cause,
 * which is precisely the error this programme is being built to avoid making.
 * So there is no default channel, no "probably SMS", and no inference from
 * adjacency — a value is written only when the order actually carries it.
 */
export type ContributionAttribution = {
  /** Which lifecycle channel funded a gift on this order, when one did. */
  giftChannel?: "sms" | "email" | null;
  /** The `customer_offers` row a gift came from. */
  offerId?: string | null;
  offerKey?: string | null;
  /** The lifecycle campaign this order is attributed to. Populated from M8. */
  campaignKey?: string | null;
  /** The specific send. Populated from M8. */
  sendReferenceId?: string | null;
};

/** Trim to a non-empty string, or null. Blank is not a value. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Write the snapshot. Best-effort, and deliberately so.
 *
 * Returns nothing a caller can branch on. There is no outcome of this function
 * that should change what happens to the order, so there is no outcome to
 * return — the type is the guarantee.
 */
export async function recordContributionSnapshot(
  orderId: string,
  contribution: ContributionBreakdown | null | undefined,
  attribution: ContributionAttribution = {},
): Promise<void> {
  const id = text(orderId);
  if (!id || !contribution) return;

  try {
    const { error } = await supabaseAdmin
      .from("order_contribution")
      .upsert({
        order_id: id,

        formula_version: contribution.formulaVersion,
        basis: contribution.basis,
        cost_is_estimated: contribution.costIsEstimated,

        paid_merchandise_cents: contribution.paidMerchandiseCents,
        shipping_collected_cents: contribution.shippingCollectedCents,
        handling_collected_cents: contribution.handlingCollectedCents,
        product_cost_cents: contribution.productCostCents,
        gift_cogs_cents: contribution.giftCogsCents,
        processing_fee_cents: contribution.processingFeeCents,
        shipping_cost_cents: contribution.shippingCostCents,
        store_credit_redeemed_cents: contribution.storeCreditRedeemedCents,
        points_redeemed_value_cents: contribution.pointsRedeemedValueCents,
        points_earned_value_cents: contribution.pointsEarnedValueCents,
        contribution_before_commission_cents: contribution.contributionBeforeCommissionCents,

        binding_constraint: contribution.bindingConstraint,

        // NULL WHEN UNKNOWN, never a guess. `?? null` rather than a default.
        gift_channel: attribution.giftChannel ?? null,
        offer_id: text(attribution.offerId),
        offer_key: text(attribution.offerKey),
        campaign_key: text(attribution.campaignKey),
        send_reference_id: text(attribution.sendReferenceId),
      }, { onConflict: "order_id", ignoreDuplicates: true });

    if (error) {
      // THE TABLE MAY NOT EXIST YET on a deployment that is behind the
      // migration. That is a reporting gap, not an incident, and it must read
      // as one — the order itself is untouched either way.
      await recordSystemAlert({
        type: "order_contribution_write_failed",
        severity: "warning",
        message:
          `Could not record the contribution snapshot for order ${id}. The order is unaffected; `
          + "this is a marketing-analytics gap. If this is every order, src/lib/sql/order-contribution.sql "
          + "has not been applied to this database.",
        context: { orderId: id, detail: error.message ?? String(error), code: error.code ?? null },
        dedupeWindowMs: 60 * 60 * 1000,
      }).catch(() => {});
    }
  } catch (error) {
    // A thrown client error (network, auth) lands here. Same posture: the sale
    // is made, so this is logged and dropped.
    console.error("[contribution] unable to record snapshot", orderId, error);
  }
}
