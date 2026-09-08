import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isOfferKey, type OfferKey } from "@/lib/offers/customer-offers";
import type { RecoveryStage } from "@/lib/cart-recovery";

/**
 * Per-cart replacements for one stage of the recovery sequence.
 *
 * See cart-recovery-stage-overrides.sql for why this replaces a body rather
 * than adding a send. The short version: the sweep's claim on
 * (abandoned_cart_id, stage) is what makes a stage send exactly once, and an
 * override rides inside that claim instead of around it — so it inherits every
 * idempotency property the sequence already has rather than needing its own.
 */
export interface CartRecoveryOverride {
  cartId: string;
  stage: RecoveryStage;
  /** The gift to mint behind the stage claim, or null for a body-only change. */
  offerKey: OfferKey | null;
  /**
   * Extra things this order carries, stated verbatim in the message.
   *
   * ON THE ROW, NOT IN CODE, because each one is an operator's promise about
   * how a specific order will be handled — expedited postage, say — and the
   * store cannot verify it the way it verifies a price. Recording it against
   * the cart is what makes it findable later by whoever packs the box, instead
   * of living only in an email nobody on the fulfilment side ever sees.
   */
  perks: string[];
  note: string | null;
  /**
   * When this replaced stage already went out, or null.
   *
   * THE TWO SEND PATHS READ THIS DIFFERENTLY, on purpose. The sweep ignores it
   * — its claim on (cart, stage) already makes a second send impossible, and
   * if one were somehow re-attempted it must carry the SAME bespoke body
   * rather than silently reverting to the generic one. The operator resend has
   * no such claim (reusing the row is the whole point of a resend), so this is
   * the only thing standing between a second click and a second gift email.
   */
  consumedAt: string | null;
}

/**
 * Every override for the carts this sweep is about to work on.
 *
 * ONE READ FOR THE WHOLE SWEEP, keyed `cartId::stage`, for the same reason the
 * claimed stages and the paid orders are read in bulk: a per-cart query inside
 * the send loop turns a 200-cart sweep into 200 round trips.
 *
 * A FAILURE HERE IS NOT A FAILURE OF THE SWEEP. If the table cannot be read —
 * an un-migrated database, a transport blip — every cart simply has no
 * override and the ordinary sequence goes out. That is the safe direction:
 * the shopper gets the normal reminder rather than nothing, and the override
 * is still there for the next sweep. It is logged rather than swallowed,
 * because "the gift silently stopped being attached" must not be invisible.
 */
/**
 * THE PERK LIST AN OVERRIDE EMAIL SHOWS — ONE FUNCTION, TWO CALLERS.
 *
 * The store adds "Free shipping" when the sitewide switch is on, and the
 * operator can type it into an override's own perks as well. All four override
 * rows waiting to send do exactly that, so the list rendered as:
 *
 *     Free shipping / Free shipping / 2-day shipping, on us
 *
 * WHY IT LIVES HERE RATHER THAN AT EITHER CALL SITE. The sweep and the admin
 * resend each had their own copy of the two lines that build this, so fixing
 * the sweep left the resend — the path the operator actually presses, on the
 * highest-value cart in the store — still duplicating. Two copies of a rule is
 * how that happens; one function is the fix, and perk-dedupe.test.ts pins both
 * callers to it.
 *
 * Case- and whitespace-insensitive, FIRST OCCURRENCE WINS, so the operator's
 * own wording survives and the store's is what gets dropped.
 */
export function resolveOverridePerks(
  perks: ReadonlyArray<string>,
  freeShippingSitewide: boolean,
): string[] {
  const seen = new Set<string>();
  return (freeShippingSitewide ? ["Free shipping", ...perks] : [...perks]).filter((perk) => {
    const key = String(perk ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadCartRecoveryOverrides(
  cartIds: readonly string[],
): Promise<Map<string, CartRecoveryOverride>> {
  const found = new Map<string, CartRecoveryOverride>();
  const ids = [...new Set(cartIds.map(String).filter(Boolean))];
  if (ids.length === 0) return found;

  try {
    const { data, error } = await supabaseAdmin
      .from("cart_recovery_stage_overrides")
      .select("abandoned_cart_id, stage, offer_key, perks, note, consumed_at")
      .in("abandoned_cart_id", ids);
    if (error) throw error;
    for (const row of data ?? []) {
      const cartId = String(row.abandoned_cart_id ?? "");
      const stage = String(row.stage ?? "") as RecoveryStage;
      if (!cartId || !stage) continue;
      const rawKey = row.offer_key === null || row.offer_key === undefined ? null : String(row.offer_key);
      // AN UNKNOWN KEY IS NOT A GIFT OF NOTHING, it is a row naming a
      // catalogue entry that has since been retired. Dropping the whole
      // override sends the ordinary reminder; honouring it with a null offer
      // would send bespoke copy promising a gift that cannot be minted.
      if (rawKey !== null && !isOfferKey(rawKey)) {
        console.error("[cart-recovery] override names an unknown offer key; ignoring it", cartId, stage, rawKey);
        continue;
      }
      const perks = Array.isArray(row.perks)
        ? row.perks.map((perk) => String(perk ?? "").trim()).filter(Boolean)
        : [];
      found.set(`${cartId}::${stage}`, {
        cartId,
        stage,
        offerKey: rawKey as OfferKey | null,
        perks,
        note: row.note === null || row.note === undefined ? null : String(row.note),
        consumedAt: row.consumed_at ? String(row.consumed_at) : null,
      });
    }
  } catch (error) {
    console.error("[cart-recovery] stage overrides unavailable; sending the ordinary sequence", error);
    return new Map();
  }
  return found;
}

/**
 * Record that a replaced stage went out.
 *
 * Observability, not control. `abandoned_cart_emails` is what stops a second
 * send; nothing reads this back to decide whether to send, and the template
 * lookup deliberately ignores it — a re-attempted send must carry the same
 * bespoke body, never quietly revert to the generic one. Best-effort for the
 * same reason: failing to write a breadcrumb must not fail a send that already
 * happened.
 */
export async function markCartRecoveryOverrideConsumed(input: {
  cartId: string;
  stage: RecoveryStage;
  reservationId: string;
}): Promise<void> {
  try {
    await supabaseAdmin
      .from("cart_recovery_stage_overrides")
      .update({ consumed_at: new Date().toISOString(), consumed_email_id: input.reservationId })
      .eq("abandoned_cart_id", input.cartId)
      .eq("stage", input.stage)
      .is("consumed_at", null);
  } catch (error) {
    console.error("[cart-recovery] could not stamp override as consumed", input.cartId, input.stage, error);
  }
}
