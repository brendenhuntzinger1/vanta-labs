import "server-only";

import { getCartRecoveryControlConfig } from "@/lib/admin-control";
import {
  CART_STATUS_OPEN,
  lastGiftForOtherCarts,
  loadRecoveryContext,
  restoreUrl,
  unshippableGiftSlugsFor,
  type AbandonedCartItemSnapshot,
} from "@/lib/cart-recovery";
import {
  planStageOffer,
  recoveryGiftConfig,
  RECOVERY_GIFT_OFFER_KEY,
  RECOVERY_GIFT_TTL_DAYS,
} from "@/lib/cart-recovery-offers";
import { DEFAULT_RECOVERY_TIERS } from "@/lib/cart-recovery-tiers";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { omnisendActive } from "@/lib/marketing/omnisend/client";
import {
  CART_OFFER_MAX_AGE_MS,
  cartOfferQualifies,
  describeRecoveryGift,
  giftDisplayName,
  type CartOfferCartRow,
} from "@/lib/marketing/omnisend/cart-plan";
import { ensureContactCode, findLiveContactCodes } from "@/lib/marketing/omnisend/codes";
import { omnisendOwnsMarketing } from "@/lib/marketing/omnisend/config";
import type { RecoveryGiftFacts } from "@/lib/marketing/omnisend/contact-payload";
import { upsertOmnisendContact } from "@/lib/marketing/omnisend/contacts";
import { contactLinkFor, sendCartEventOnce } from "@/lib/marketing/omnisend/hooks";
import { omnisendLedger } from "@/lib/marketing/omnisend/ledger";
import { OMNISEND_LINK_TTL_MS, signOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import { issueResolvedOffer } from "@/lib/offers/customer-offers";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * STORE-MINTED INCENTIVES FOR OMNISEND'S ABANDONED-CART FLOW.
 *
 * Omnisend's flow sends its third message 72 hours after the cart event
 * (spec §6), and that message may carry a discount and a gift. Omnisend can
 * mint neither for an API store: the code has to be a coupons row bound to
 * the address, and the gift has to be a customer_offers row redeemed through
 * the token link that sets the vl_offer cookie. So this sweep prepares both
 * close to dispatch and hands them to Omnisend as contact properties
 * (contact-payload.ts vl_recovery_*); the template shows whichever blocks
 * are ready. Nothing here mails anyone.
 *
 * THE RULES ARE THE LADDER'S, NOT A SECOND SET. The band planner
 * (planStageOffer at stage t72h), the per-address cooldowns
 * (loadRecoveryContext), the shippable-gift test (unshippableGiftSlugsFor)
 * and the offer helper (issueResolvedOffer) are the in-house sweep's own,
 * so the two owners of a cart can never disagree about what an address has
 * already been given or what the box will hold. The percentage is the
 * BAND's, carried into the coupon row (ensureContactCode with percent), so
 * the property describes the code the till will price.
 *
 * ONE OWNER PER CART. Only a cart with NO in-house stage is planned; a cart
 * the ladder has touched finishes there. And ONCE PER CART: the ledger claim
 * "recovery offer" is taken before the plan, so a sweep that runs every
 * 30 minutes cannot re-mint, and a cart is never re-planned even when the
 * push failed — a refused push is recorded, not retried, exactly as the
 * ladder keeps a failed stage's claim (C-06).
 *
 * Gate FIRST, before any database read: the environment gate, then the
 * ownership switch. With the switch unset the ladder owns every cart and
 * this does nothing at all.
 */

const LOG = "[omnisend/cart-offers]";
const DEFAULT_LIMIT = 50;
/** More than any tick will find inside a 96-hour window at this store's volume. */
const SCAN_LIMIT = 500;

export type OmnisendCartOffersResult = {
  skipped: string | null;
  /** Open carts read inside the window. */
  scanned: number;
  /** Carts the pure rule accepted (no in-house stage, no purchase since, in the window). */
  qualified: number;
  /** Carts planned this tick, behind a fresh claim. */
  planned: number;
  /** Recovery codes minted or re-offered. */
  codes: number;
  /** Gift offers issued. */
  gifts: number;
  /** Catch-up `added product to cart` events accepted. */
  events: number;
  /** Contact pushes Omnisend refused, or plans that threw. */
  failed: number;
};

function empty(): OmnisendCartOffersResult {
  return { skipped: null, scanned: 0, qualified: 0, planned: 0, codes: 0, gifts: 0, events: 0, failed: 0 };
}

type CartRow = CartOfferCartRow & { session_id?: string | null };

/**
 * How many in-house stages each cart has. Null when the table could not be
 * read: this sweep then plans NOTHING, because a cart wrongly taken for
 * Omnisend's would be minted an offer while the ladder is still mailing it.
 */
async function inHouseStagesFor(cartIds: string[]): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  if (cartIds.length === 0) return counts;
  try {
    const { data, error } = await supabaseAdmin
      .from("abandoned_cart_emails")
      .select("abandoned_cart_id")
      .in("abandoned_cart_id", cartIds);
    if (error) {
      console.error(LOG, "stage read refused; planning nothing this tick", error.message);
      return null;
    }
    for (const row of (data ?? []) as Array<{ abandoned_cart_id?: string | null }>) {
      const id = String(row.abandoned_cart_id ?? "");
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  } catch (error) {
    console.error(LOG, "stage read failed; planning nothing this tick", error);
    return null;
  }
}

/** Has this cart's `added product to cart` ever been delivered? Fails OPEN (true), so a ledger outage does not re-trigger flows. */
async function cartEventKnown(cartId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("omnisend_events_sent")
      .select("entity_id")
      .eq("entity_id", cartId)
      .eq("event_name", "added product to cart")
      .limit(1);
    if (error) return true;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return true;
  }
}

export async function mintOmnisendCartOffers(input: { now?: number; limit?: number } = {}): Promise<OmnisendCartOffersResult> {
  const active = omnisendActive();
  if (!active.active) return { ...empty(), skipped: active.reason };
  if (!omnisendOwnsMarketing()) return { ...empty(), skipped: "in-house ladder owns marketing" };

  const result = empty();
  try {
    const now = input.now ?? Date.now();
    const limit = Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT));
    const config = await getCartRecoveryControlConfig();
    const tiers = config.tiers ?? DEFAULT_RECOVERY_TIERS;

    // Every open cart with activity inside the window. The exact age test —
    // last activity between 36 and 96 hours ago — is the pure rule's; the
    // query only bounds the read by the outer edge, the way the ladder does.
    const oldestActivityIso = new Date(now - CART_OFFER_MAX_AGE_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("abandoned_carts")
      .select("id, session_id, email, items, cart_value_cents, first_seen_at, last_updated_at, status")
      .in("status", CART_STATUS_OPEN)
      .or(`last_updated_at.gte.${oldestActivityIso},first_seen_at.gte.${oldestActivityIso}`)
      .order("first_seen_at", { ascending: true })
      .limit(SCAN_LIMIT);
    if (error) throw error;
    const rows = ((data ?? []) as CartRow[]).filter((row) => Boolean(row?.id));
    result.scanned = rows.length;
    if (rows.length === 0) return result;

    const stagesByCart = await inHouseStagesFor(rows.map((row) => String(row.id)));
    if (stagesByCart === null) return { ...result, skipped: "in-house stages unreadable" };

    const emails = [...new Set(rows.map((row) => String(row.email ?? "").trim().toLowerCase()).filter(Boolean))];
    const context = await loadRecoveryContext(emails, now);

    const candidates = rows.filter((row) => {
      const email = String(row.email ?? "").trim().toLowerCase();
      const verdict = cartOfferQualifies({
        row,
        now,
        inHouseStages: stagesByCart.get(String(row.id)) ?? 0,
        paidOrders: context.paidOrders.get(email) ?? [],
      });
      return verdict.qualifies;
    });
    result.qualified = candidates.length;
    if (candidates.length === 0) return result;

    // THE GIFTS, NAMED AND CHECKED ONCE FOR THE TICK. Every band's stage-four
    // gift is known before any cart is planned, so one catalogue read names
    // them (for the customer-facing text and the offer row's label) and one
    // stock read says which can ship — the same test the ladder applies.
    const giftSlugs = [...new Set(tiers.flatMap((tier) => tier.stage4.gifts.map((item) => item.slug)))];
    const [giftProducts, unshippable] = await Promise.all([
      giftSlugs.length > 0 ? getCatalogProductsBySlugs(giftSlugs) : Promise.resolve([]),
      unshippableGiftSlugsFor(giftSlugs),
    ]);
    const giftNames = new Map<string, string>(
      giftProducts.map((product) => [String(product.slug), giftDisplayName(String(product.slug), product.name)]),
    );

    for (const row of candidates) {
      if (result.planned >= limit) break;
      const cartId = String(row.id);
      const email = String(row.email ?? "").trim().toLowerCase();
      const ledger = omnisendLedger(cartId);
      // ONCE PER CART. The claim is an insert; a second tick, or a second
      // instance of this tick, loses the race and plans nothing.
      if (!(await ledger.claimSend("recovery offer", `${cartId}:recovery offer`))) continue;
      result.planned += 1;

      try {
        const plan = planStageOffer({
          stage: "t72h",
          cartValueCents: Math.max(0, Math.round(Number(row.cart_value_cents ?? 0) || 0)),
          lastPaidAt: context.paidOrders.get(email)?.[0]?.at ?? null,
          lastRecoveryCouponAt: context.lastRecoveryCouponAt.get(email) ?? null,
          lastRecoveryGiftAt: lastGiftForOtherCarts(context.recoveryGifts.get(email), cartId),
          discountPercent: config.discountPercent,
          tiers,
          now,
        });

        // THE CODE, AT THE BAND'S PERCENTAGE. A live recovery code is
        // re-offered as it is; a new one carries plan.percent into the row.
        if (plan.coupon && plan.percent > 0) {
          const minted = await ensureContactCode("recovery", email, { percent: plan.percent });
          if (minted) result.codes += 1;
          else console.error(LOG, "recovery discount could not be minted", cartId);
        }

        // THE GIFT, ONLY WHAT CAN SHIP. Dropped entirely when nothing in the
        // band's gift is on the shelf: a message promising a vial the box
        // will not hold is the one failure this programme cannot afford.
        let recoveryGift: RecoveryGiftFacts | null = null;
        const gifts = plan.gifts.filter((item) => !unshippable.has(item.slug));
        if (gifts.length > 0) {
          const giftConfig = recoveryGiftConfig(gifts, giftNames, 0, plan.minCartCents);
          if (giftConfig) {
            const issued = await issueResolvedOffer({ email, offerKey: RECOVERY_GIFT_OFFER_KEY, config: giftConfig, referenceId: cartId, now });
            if (issued) {
              // The claim link the in-house recovery email carries — the click
              // tracker, which sets the vl_offer cookie from `o` and lands on
              // the restored cart — wrapped in the contact's own signed door so
              // the click also clears the account wall (spec §3.3).
              const claimPath = `/api/email/track/click?url=${encodeURIComponent(restoreUrl(cartId))}&o=${encodeURIComponent(issued.token)}`;
              recoveryGift = {
                text: describeRecoveryGift(gifts, giftNames),
                link: await contactLinkFor(email, "abandoned-cart")(claimPath),
                minCartCents: plan.minCartCents,
                endsAt: issued.expiresAt,
              };
              result.gifts += 1;
            } else {
              console.error(LOG, "gift could not be minted", cartId);
            }
          }
        }

        // THE CONTACT, WITH EVERYTHING THAT IS NOW TRUE OF IT: a fresh
        // 30-day door, every live code (the recovery one now among them) and
        // the gift. The plan's own words are logged for the operator; the
        // codes and the token are not.
        const [token, codes] = await Promise.all([signOmnisendLink(email, now), findLiveContactCodes(email)]);
        const link = token ? { token, endsAt: new Date(now + OMNISEND_LINK_TTL_MS).toISOString() } : null;
        const accepted = await upsertOmnisendContact(email, { link, codes, recoveryGift });
        if (!accepted) result.failed += 1;

        // A CART ABANDONED JUST BEFORE CUTOVER never produced a cart event —
        // the hooks did not exist — and has received nothing from the
        // ladder, so Omnisend's flow starting at step one is correct. Sent
        // exactly once; a cart already in the ledger is already in the flow.
        if (!(await cartEventKnown(cartId))) {
          const sentEvent = await sendCartEventOnce({
            name: "added product to cart",
            cart: {
              cartId,
              sessionId: String(row.session_id ?? ""),
              email,
              items: (Array.isArray(row.items) ? row.items : []) as AbandonedCartItemSnapshot[],
              cartValueCents: Math.max(0, Math.round(Number(row.cart_value_cents ?? 0) || 0)),
            },
            campaign: "abandoned-cart",
            debounceMs: null,
          });
          if (sentEvent) result.events += 1;
        }

        await ledger.recordSend("recovery offer", `${cartId}:recovery offer`, accepted, accepted ? null : "contact upsert refused");
        console.log(LOG, "planned", cartId, { reason: plan.reason, gift: recoveryGift !== null, accepted, ttlDays: RECOVERY_GIFT_TTL_DAYS });
      } catch (error) {
        // The plan never landed, so the claim must not outlive it.
        await ledger.releaseSend("recovery offer");
        result.failed += 1;
        console.error(LOG, "plan threw", cartId, error);
      }
    }

    return result;
  } catch (error) {
    console.error(LOG, "sweep failed", error);
    return { ...result, skipped: "sweep failed" };
  }
}
