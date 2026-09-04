import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { decodeAutomationCookie } from "@/lib/email/automation-links";
import { decodeAttributionCookie } from "@/lib/email/campaign-links";
import { isAutomationKey } from "@/lib/email/automation-catalog";

/**
 * ONE PRIMARY MARKETING SOURCE PER ORDER.
 *
 * The store records several marketing touches on an order — a campaign click,
 * an automation click, a redeemed gift token, a cart-recovery coupon, an
 * ambassador code, an ad click id — and until now every surface that read one
 * of them counted the whole order for itself. One $150 order could be $150 of
 * campaign revenue and $150 of automation revenue and $150 "recovered", and no
 * page said so.
 *
 * This module decides ONE channel per order, deterministically, from the
 * evidence in this order of strength:
 *
 *   1. offer_redeemed   a private gift token was spent on this order. Only one
 *                       automation email ever carried that token, so this is
 *                       proof, click or no click. Credits that automation.
 *   2. click            a tracked email link inside its 7-day window. When
 *                       both an automation and a campaign were clicked, the
 *                       LATER click wins (last touch).
 *   3. recovery_coupon  the order used a SAVE- code minted by cart recovery.
 *   4. referral_code    the customer typed an ambassador code. The ambassador
 *                       is paid commission regardless — that ledger is
 *                       separate and untouched — this only says which channel
 *                       the marketing report credits.
 *   5. ad_touch         a UTM / click id recorded by the ads pipeline.
 *   6. organic          nothing above.
 *
 * Written at order creation from the click cookies (basis 'click'), and again
 * when the order is paid, when the gift redemption and the coupon are known.
 * The paid-time decision may UPGRADE a click stamp to offer_redeemed for the
 * same or a different automation; it never moves credit for any other reason,
 * and a replayed webhook makes the same decision again (idempotent).
 *
 * The per-channel columns (attributed_campaign_id, attributed_automation_key)
 * stay as the record of ASSISTED touches. Only the primary columns feed a
 * revenue number.
 */

export const MARKETING_SOURCE_KINDS = ["automation", "campaign", "cart_recovery", "ambassador", "ad", "organic"] as const;
export type MarketingSourceKind = (typeof MARKETING_SOURCE_KINDS)[number];
export type MarketingSourceBasis = "offer_redeemed" | "click" | "recovery_coupon" | "referral_code" | "ad_touch" | "none";

export type MarketingSourceDecision = {
  kind: MarketingSourceKind;
  ref: string | null;
  basis: MarketingSourceBasis;
};

export type MarketingSignals = {
  /** customer_offers row redeemed by this order, if any. */
  redeemedOffer?: { automationKey: string | null; offerKey: string } | null;
  automationClick?: { key: string; clickedAtMs: number } | null;
  campaignClick?: { campaignId: string; clickedAtMs: number } | null;
  /** The order's coupon, when it was minted by cart recovery. */
  recoveryCoupon?: { code: string } | null;
  ambassadorId?: string | null;
  adTouch?: { source: string | null; campaign: string | null; clickId: string | null } | null;
};

/** Pure. The whole rule, in one place, so it can be tested without a database. */
export function resolveMarketingSource(signals: MarketingSignals): MarketingSourceDecision {
  if (signals.redeemedOffer) {
    const key = signals.redeemedOffer.automationKey
      ?? (signals.automationClick && isAutomationKey(signals.automationClick.key) ? signals.automationClick.key : null);
    return { kind: "automation", ref: key ?? `offer:${signals.redeemedOffer.offerKey}`, basis: "offer_redeemed" };
  }

  const automationClick = signals.automationClick && isAutomationKey(signals.automationClick.key) ? signals.automationClick : null;
  const campaignClick = signals.campaignClick && signals.campaignClick.campaignId ? signals.campaignClick : null;
  if (automationClick || campaignClick) {
    // Last touch. On an exact tie the automation wins: it is the more specific
    // message, and a tie only arises when the click times are unknown.
    const automationWins = automationClick && (!campaignClick || automationClick.clickedAtMs >= campaignClick.clickedAtMs);
    return automationWins
      ? { kind: "automation", ref: automationClick!.key, basis: "click" }
      : { kind: "campaign", ref: campaignClick!.campaignId, basis: "click" };
  }

  if (signals.recoveryCoupon?.code) {
    return { kind: "cart_recovery", ref: signals.recoveryCoupon.code, basis: "recovery_coupon" };
  }
  if (signals.ambassadorId) {
    return { kind: "ambassador", ref: String(signals.ambassadorId), basis: "referral_code" };
  }
  if (signals.adTouch && (signals.adTouch.campaign || signals.adTouch.source || signals.adTouch.clickId)) {
    return { kind: "ad", ref: signals.adTouch.campaign ?? signals.adTouch.source ?? signals.adTouch.clickId, basis: "ad_touch" };
  }
  return { kind: "organic", ref: null, basis: "none" };
}

/**
 * Whether a paid-time decision may replace what is already on the order.
 *
 * Nothing is written over a non-null kind except one upgrade: a click stamp
 * giving way to a redeemed gift token. Everything else on a stamped order is
 * left alone, so a replayed webhook, a repair sweep or a later edit can never
 * move revenue between channels.
 */
export function mayReplaceMarketingSource(current: { kind: string | null; basis: string | null }, next: MarketingSourceDecision): boolean {
  if (!current.kind) return true;
  return current.basis === "click" && next.basis === "offer_redeemed";
}

type SourceRow = {
  marketing_source_kind: string | null;
  marketing_source_ref: string | null;
  marketing_source_basis: string | null;
};

async function writeDecision(orderId: string, current: SourceRow | null, decision: MarketingSourceDecision, now: number): Promise<boolean> {
  let query = supabaseAdmin
    .from("orders")
    .update({
      marketing_source_kind: decision.kind,
      marketing_source_ref: decision.ref,
      marketing_source_basis: decision.basis,
      marketing_source_at: new Date(now).toISOString(),
    })
    .eq("order_id", orderId);
  // The guard is repeated in the WHERE so two concurrent writers cannot both
  // win: whichever runs second finds the column no longer in the state it
  // decided against.
  query = current?.marketing_source_kind
    ? query.eq("marketing_source_basis", "click")
    : query.is("marketing_source_kind", null);
  const { data, error } = await query.select("order_id");
  if (error) {
    console.error("[marketing-source] unable to stamp order", orderId, error.message);
    return false;
  }
  // Zero rows is the guard doing its job: another writer got there first, or
  // the order is no longer in the state this decision was made against.
  return (data ?? []).length > 0;
}

/**
 * At order creation: decide from the click cookies alone.
 *
 * Non-throwing, like the two attribute* helpers beside it. A missing column
 * (un-migrated database) is logged and costs the stamp, never the order.
 */
export async function stampMarketingSourceAtCreation(input: {
  orderId: string;
  automationCookie: string | null | undefined;
  campaignCookie: string | null | undefined;
  now?: number;
}): Promise<MarketingSourceDecision | null> {
  try {
    const now = input.now ?? Date.now();
    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) return null;
    const automation = decodeAutomationCookie(input.automationCookie, now);
    const campaign = decodeAttributionCookie(input.campaignCookie, now);
    const decision = resolveMarketingSource({
      automationClick: automation ? { key: automation.automationKey, clickedAtMs: automation.clickedAtMs } : null,
      campaignClick: campaign ? { campaignId: campaign.campaignId, clickedAtMs: campaign.clickedAtMs } : null,
    });
    if (decision.kind === "organic") return null;   // nothing known yet; the paid-time pass decides
    const written = await writeDecision(orderId, null, decision, now);
    return written ? decision : null;
  } catch (error) {
    console.error("[marketing-source] creation stamp failed", error);
    return null;
  }
}

/**
 * At payment: decide from everything the order now records.
 *
 * Runs in both paid lanes after the gift has been redeemed, so a spent token
 * is visible. Reads with its own narrow selects rather than widening the
 * webhook's order query — a missing column would otherwise fail every money
 * decision in the webhook. Never throws.
 */
export async function finalizeMarketingSource(input: { orderId: string; now?: number }): Promise<MarketingSourceDecision | null> {
  const orderId = String(input.orderId ?? "").trim();
  if (!orderId) return null;
  const now = input.now ?? Date.now();
  try {
    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("ambassador_id, coupon_code, attributed_campaign_id, attributed_at, attributed_automation_key, attributed_automation_at, marketing_source_kind, marketing_source_ref, marketing_source_basis")
      .eq("order_id", orderId)
      .maybeSingle();
    if (error || !order) {
      if (error) console.error("[marketing-source] unable to read order", orderId, error.message);
      return null;
    }
    const row = order as SourceRow & {
      ambassador_id: string | null; coupon_code: string | null;
      attributed_campaign_id: string | null; attributed_at: string | null;
      attributed_automation_key: string | null; attributed_automation_at: string | null;
    };

    // EVERY SIGNAL IS READ, OR NOTHING IS WRITTEN. supabase-js resolves a
    // PostgREST error rather than throwing it, so a lookup shaped "data or
    // null" turns an un-migrated column, a permissions problem or a passing
    // outage into "no gift, no coupon, no ad touch" — and the decision below
    // is write-once. A read that failed is a reason to abstain, not evidence.
    type Read<T> = { ok: true; value: T } | { ok: false; reason: string };
    const failed = (what: string, error: unknown): Read<never> => ({
      ok: false,
      reason: `${what}: ${error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)}`,
    });
    const [redeemedRead, couponRead, adRead] = await Promise.all([
      supabaseAdmin
        .from("customer_offers")
        .select("automation_key, offer_key")
        .eq("redeemed_order_id", orderId)
        .limit(1)
        .then(({ data, error }): Read<{ automationKey: string | null; offerKey: string } | null> => {
          if (error) return failed("customer_offers", error);
          const hit = (data ?? [])[0] as { automation_key?: string | null; offer_key?: string } | undefined;
          return { ok: true, value: hit ? { automationKey: hit.automation_key ?? null, offerKey: String(hit.offer_key ?? "") } : null };
        }, (error) => failed("customer_offers", error)),
      row.coupon_code
        ? supabaseAdmin
            .from("coupons")
            .select("code, source")
            .eq("code", row.coupon_code)
            .maybeSingle()
            .then(({ data, error }): Read<{ code: string } | null> => {
              if (error) return failed("coupons", error);
              const hit = data as { code?: string; source?: string | null } | null;
              return { ok: true, value: hit && hit.source === "cart_recovery" ? { code: String(hit.code) } : null };
            }, (error) => failed("coupons", error))
        : Promise.resolve<Read<{ code: string } | null>>({ ok: true, value: null }),
      supabaseAdmin
        .from("order_attribution")
        .select("last_utm_source, last_utm_campaign, last_ttclid, last_fbclid, last_gclid")
        .eq("order_id", orderId)
        .maybeSingle()
        .then(({ data, error }): Read<{ source: string | null; campaign: string | null; clickId: string | null } | null> => {
          if (error) return failed("order_attribution", error);
          const hit = data as { last_utm_source?: string | null; last_utm_campaign?: string | null; last_ttclid?: string | null; last_fbclid?: string | null; last_gclid?: string | null } | null;
          if (!hit) return { ok: true, value: null };
          const clickId = hit.last_ttclid ? "ttclid" : hit.last_fbclid ? "fbclid" : hit.last_gclid ? "gclid" : null;
          return { ok: true, value: { source: hit.last_utm_source ?? null, campaign: hit.last_utm_campaign ?? null, clickId } };
        }, (error) => failed("order_attribution", error)),
    ]);
    if (!redeemedRead.ok || !couponRead.ok || !adRead.ok) {
      const reasons = [redeemedRead, couponRead, adRead].flatMap((r) => (r.ok ? [] : [r.reason]));
      console.error("[marketing-source] abstaining: a signal could not be read", orderId, reasons.join("; "));
      return null;
    }
    let redeemedOffer = redeemedRead.value;
    const recoveryCoupon = couponRead.value;
    const adTouch = adRead.value;

    // A gift minted before automation_key existed still belongs to exactly
    // one automation: the one whose configuration carries that offer. Look
    // it up so the order lands on that automation's row rather than on a
    // reference no panel can render.
    if (redeemedOffer && !redeemedOffer.automationKey && redeemedOffer.offerKey) {
      const { data: carriers, error: carrierError } = await supabaseAdmin
        .from("email_automations")
        .select("key")
        .eq("offer_key", redeemedOffer.offerKey)
        .limit(1);
      if (carrierError) {
        console.error("[marketing-source] abstaining: email_automations could not be read", orderId, carrierError.message);
        return null;
      }
      const carrier = (carriers ?? [])[0] as { key?: string } | undefined;
      if (carrier?.key) redeemedOffer = { ...redeemedOffer, automationKey: String(carrier.key) };
    }

    // Clicks: the creation stamp already chose the later one and recorded it
    // as the primary; the per-channel columns say what was touched at all. The
    // stamp times are creation times, so on an order with both and no
    // creation stamp the tie goes to the automation.
    const automationClick = row.attributed_automation_key
      ? { key: row.attributed_automation_key, clickedAtMs: row.marketing_source_kind === "campaign" ? 0 : 1 }
      : null;
    const campaignClick = row.attributed_campaign_id
      ? { campaignId: row.attributed_campaign_id, clickedAtMs: row.marketing_source_kind === "campaign" ? 1 : 0 }
      : null;

    const decision = resolveMarketingSource({
      redeemedOffer,
      automationClick,
      campaignClick,
      recoveryCoupon,
      ambassadorId: row.ambassador_id,
      adTouch,
    });

    if (!mayReplaceMarketingSource({ kind: row.marketing_source_kind, basis: row.marketing_source_basis }, decision)) {
      return {
        kind: (row.marketing_source_kind ?? "organic") as MarketingSourceKind,
        ref: row.marketing_source_ref,
        basis: (row.marketing_source_basis ?? "none") as MarketingSourceBasis,
      };
    }
    const written = await writeDecision(orderId, row, decision, now);
    return written ? decision : null;
  } catch (error) {
    console.error("[marketing-source] finalize failed", orderId, error);
    return null;
  }
}
