import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { SPIN_OFFER_KEY_PREFIX, spinOfferKey } from "@/lib/spin/offer-key";
import { SPIN_PRIZES } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// WHAT A WHEEL CAMPAIGN ACTUALLY DID.
//
// Read off customer_offers, which is the only record that matters: the offer
// row IS the prize, and it carries its own redemption. There is no separate
// "spins" table and there should not be one — a second record of the same fact
// is a second thing to get out of step.
//
// EVERY FIGURE HERE IS COUNTED, NOT ESTIMATED. The admin screen this feeds
// reports results beside a Send button, and a rounded or sampled number there
// is worse than no number: it reads as fact.
// ---------------------------------------------------------------------------

export type SpinCampaignResults = {
  campaignId: string;
  /** Prizes awarded — one row per customer who span. */
  spins: number;
  /** Awarded and spent on a paid order. */
  redeemed: number;
  /** Awarded, unspent, still inside its 72 hours. */
  live: number;
  /** Awarded, unspent, past its deadline. */
  expired: number;
  /** Withdrawn by hand. */
  revoked: number;
  /** Held by a checkout that has not settled. */
  reserved: number;
  /** Redeemed ÷ spins, as a percentage, or null when nobody has span. */
  redemptionRatePercent: number | null;
  /** Per prize, in wheel order, with what each one actually did. */
  byPrize: Array<{
    id: string;
    label: string;
    /** 1-in-16 style odds, as a count of wedges carrying this reward. */
    wedges: number;
    minSubtotalCents: number;
    awarded: number;
    redeemed: number;
  }>;
  /** True when the read failed; every figure above is then zero and unusable. */
  degraded: boolean;
};

const EMPTY = (campaignId: string): SpinCampaignResults => ({
  campaignId,
  spins: 0,
  redeemed: 0,
  live: 0,
  expired: 0,
  revoked: 0,
  reserved: 0,
  redemptionRatePercent: null,
  byPrize: [],
  degraded: true,
});

/**
 * How a stored offer row maps back to a wedge.
 *
 * The row records the REWARD, not the wedge index — deliberately, so that
 * editing the wheel later cannot change what an already-awarded prize means.
 * The consequence is that results have to be matched on reward identity, which
 * is what this does: product slug for a product, percentage for a percentage,
 * and the kind alone for free shipping.
 */
function rewardIdentity(row: {
  reward_kind: string | null;
  product_slug: string | null;
  percent_off: number | null;
}): string {
  const kind = String(row.reward_kind ?? "");
  if (kind === "free_product" || kind === "free_product_percent") return `product:${row.product_slug ?? ""}`;
  if (kind === "percent") return `percent:${Number(row.percent_off ?? 0)}`;
  return `kind:${kind}`;
}

function prizeIdentity(prize: (typeof SPIN_PRIZES)[number]): string {
  const reward = prize.reward;
  if (reward.kind === "free_product") return `product:${reward.productSlug}`;
  if (reward.kind === "percent") return `percent:${reward.percent}`;
  return `kind:${reward.kind}`;
}

/**
 * Results for one campaign, or for every campaign the wheel has ever run.
 *
 * Pass a campaignId for the current promotion. Pass nothing and it reports the
 * campaign ids it can see, which is how the screen offers a history without
 * the operator having to remember what they called things.
 */
export async function getSpinCampaignResults(campaignId: string): Promise<SpinCampaignResults> {
  const key = spinOfferKey(campaignId);
  if (!key || key === SPIN_OFFER_KEY_PREFIX) return { ...EMPTY(campaignId), degraded: false };

  try {
    const { data, error } = await supabaseAdmin
      .from("customer_offers")
      .select("reward_kind, product_slug, percent_off, redeemed_at, revoked_at, expires_at, reserved_order_id")
      .eq("offer_key", key);
    if (error) throw error;

    const rows = (data ?? []) as Array<{
      reward_kind: string | null;
      product_slug: string | null;
      percent_off: number | null;
      redeemed_at: string | null;
      revoked_at: string | null;
      expires_at: string;
      reserved_order_id: string | null;
    }>;

    const now = Date.now();
    const counts = new Map<string, { awarded: number; redeemed: number }>();
    let redeemed = 0;
    let revoked = 0;
    let expired = 0;
    let live = 0;
    let reserved = 0;

    for (const row of rows) {
      const identity = rewardIdentity(row);
      const bucket = counts.get(identity) ?? { awarded: 0, redeemed: 0 };
      bucket.awarded += 1;

      if (row.redeemed_at) {
        redeemed += 1;
        bucket.redeemed += 1;
      } else if (row.revoked_at) {
        revoked += 1;
      } else if (new Date(row.expires_at).getTime() <= now) {
        expired += 1;
      } else {
        live += 1;
        if (row.reserved_order_id) reserved += 1;
      }
      counts.set(identity, bucket);
    }

    // One row per DISTINCT prize, in wheel order, with the wedge count that
    // gives its odds — a reward on two wedges is one prize at 2-in-16, which is
    // the same grouping the customer-facing disclosure uses.
    const seen = new Set<string>();
    const byPrize: SpinCampaignResults["byPrize"] = [];
    for (const prize of SPIN_PRIZES) {
      const identity = prizeIdentity(prize);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const wedges = SPIN_PRIZES.filter((other) => prizeIdentity(other) === identity).length;
      const bucket = counts.get(identity) ?? { awarded: 0, redeemed: 0 };
      byPrize.push({
        id: prize.id,
        label: prize.label,
        wedges,
        minSubtotalCents: prize.minSubtotalCents,
        awarded: bucket.awarded,
        redeemed: bucket.redeemed,
      });
    }

    const spins = rows.length;
    return {
      campaignId,
      spins,
      redeemed,
      live,
      expired,
      revoked,
      reserved,
      redemptionRatePercent: spins > 0 ? Math.round((redeemed / spins) * 1000) / 10 : null,
      byPrize,
      degraded: false,
    };
  } catch (error) {
    console.error("[spin-results] read failed", error);
    return EMPTY(campaignId);
  }
}

/** Every campaign id the wheel has minted a prize under, newest first. */
export async function listSpinCampaignIds(): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("customer_offers")
      .select("offer_key, issued_at")
      .like("offer_key", `${SPIN_OFFER_KEY_PREFIX}%`)
      .order("issued_at", { ascending: false })
      .limit(2000);
    if (error) throw error;
    const ids: string[] = [];
    for (const row of (data ?? []) as Array<{ offer_key: string }>) {
      const id = String(row.offer_key).slice(SPIN_OFFER_KEY_PREFIX.length).trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  } catch (error) {
    console.error("[spin-results] campaign list failed", error);
    return [];
  }
}
