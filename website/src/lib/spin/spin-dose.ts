import "server-only";

import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { spinOfferKey } from "@/lib/spin/offer-key";
import { doseRungFor, prizeForOfferRow, prizeNeedsDoseChoice, type SpinDoseRung, type SpinPrize } from "@/lib/spin/prize-table";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// CHOOSING WHICH DOSE A WON PRIZE IS TAKEN IN.
//
// THE CLIENT IS NEVER AUTHORITATIVE. It sends a LABEL — "30mg" — and nothing
// else. It cannot send a variant id, a minimum, a product or a price, so there
// is no field to tamper with that the server does not derive itself:
//
//   label -> the won prize's own ladder   (rejects a dose this prize lacks)
//         -> that product's live doses    (rejects a retired or foreign dose)
//         -> the rung's minimum           (never the client's number)
//
// Because the ladder is looked up on the prize the ROW says was won, a variant
// belonging to another product has no route in: it is not on this prize's
// ladder, so it is refused before the catalogue is even consulted.
//
// WHY THE WRITE IS GUARDED ON reserved_order_id. The existing token rotation
// reads that column and then does not guard on it, which is survivable for a
// token swap. It is not survivable here: a checkout holds the offer for 24
// hours on the manual path, and changing the dose underneath it would leave
// order_items carrying the old dose's $0 line and an inventory hold on the old
// shelf while the row claims the new one. The two would never reconcile,
// because redeemed_at is never cleared.
// ---------------------------------------------------------------------------

export type DoseChoiceOutcome =
  | { ok: true; variantId: string; label: string; minSubtotalCents: number }
  | { ok: false; reason: "not_found" | "no_choice" | "unknown_dose" | "dose_unavailable" | "held_by_checkout" | "write_failed" };

/**
 * How long a checkout's hold on an offer counts as live.
 *
 * Duplicated from spin-claim.ts and customer-offers.ts, which is not ideal, but
 * matching their existing private constant is better than exporting one of them
 * and quietly changing what two other call sites mean by "held".
 */
const OFFER_HOLD_SECONDS = 1800;

type Row = {
  id: string;
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
};

/** The doses this prize can still actually be taken in, cheapest first. */
export async function availableDoseRungs(prize: SpinPrize): Promise<Array<SpinDoseRung & { variantId: string }>> {
  if (!prizeNeedsDoseChoice(prize)) return [];
  const slug = prize.reward.kind === "free_product" ? prize.reward.productSlug : null;
  if (!slug) return [];

  const [product] = await getCatalogProductsBySlugs([slug]);
  const doses = (product as { doses?: Array<{ id: string; label: string }> } | undefined)?.doses ?? [];

  // A rung whose label no longer resolves is DROPPED, not shown greyed out: the
  // customer cannot be offered something the till would then refuse them.
  return (prize.doses ?? []).flatMap((rung) => {
    const live = doses.find((dose) => dose.label.trim().toLowerCase() === rung.label.toLowerCase());
    return live ? [{ ...rung, variantId: live.id }] : [];
  });
}

/**
 * Record which dose a winner wants, and the minimum that rung carries.
 *
 * Idempotent by construction: choosing the same dose twice writes the same two
 * values, so a duplicate submit, a retry and a second tab all converge.
 */
export async function chooseSpinDose(input: {
  verifiedEmail: string;
  campaignId: string;
  label: string;
  now?: number;
}): Promise<DoseChoiceOutcome> {
  const email = String(input.verifiedEmail ?? "").trim().toLowerCase();
  const campaignId = String(input.campaignId ?? "").trim();
  if (!email || !email.includes("@") || !campaignId) return { ok: false, reason: "not_found" };

  const now = input.now ?? Date.now();

  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select("id, reward_kind, product_slug, percent_off, expires_at, reserved_order_id, reserved_at")
    .eq("offer_key", spinOfferKey(campaignId))
    .eq("email", email)
    .is("revoked_at", null)
    .is("redeemed_at", null)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "not_found" };
  const row = data as Row;
  if (new Date(row.expires_at).getTime() <= now) return { ok: false, reason: "not_found" };

  const prize = prizeForOfferRow(row);
  if (!prize) return { ok: false, reason: "not_found" };
  if (!prizeNeedsDoseChoice(prize)) return { ok: false, reason: "no_choice" };

  // Step one: is this dose even on the prize they won? Rejects a foreign
  // product's variant and an invented one alike, without a catalogue round trip.
  const rung = doseRungFor(prize, input.label);
  if (!rung) return { ok: false, reason: "unknown_dose" };

  // Step two: does it still exist in the catalogue? A rung the admin retired is
  // refused rather than stored, because storing it would mean promising a dose
  // quote-order will later withhold.
  const live = await availableDoseRungs(prize);
  const chosen = live.find((entry) => entry.label.toLowerCase() === rung.label.toLowerCase());
  if (!chosen) return { ok: false, reason: "dose_unavailable" };

  const heldAt = row.reserved_at ? new Date(row.reserved_at).getTime() : 0;
  if (row.reserved_order_id && heldAt > now - OFFER_HOLD_SECONDS * 1000) {
    return { ok: false, reason: "held_by_checkout" };
  }

  const { data: written, error: writeError } = await supabaseAdmin
    .from("customer_offers")
    .update({ variant_id: chosen.variantId, min_subtotal_cents: chosen.minSubtotalCents })
    .eq("id", row.id)
    .is("revoked_at", null)
    .is("redeemed_at", null)
    // Re-checked in the write, not just the read above: a checkout that claimed
    // the offer in between must win, or it prices one dose and ships another.
    .is("reserved_order_id", null)
    // AND THE ROWS COME BACK, because a guarded update that matches nothing is
    // not an error. Without this the conditions above are decoration: the
    // write silently does nothing and the customer is told their 30mg is
    // recorded while the row still says 5mg. Zero rows means the state moved
    // under us between the read and the write — in practice a checkout taking
    // the hold, which is the one race these guards exist for.
    .select("id");

  if (writeError) {
    console.error("[spin] unable to record the chosen dose", writeError.message);
    return { ok: false, reason: "write_failed" };
  }
  if (!written?.length) return { ok: false, reason: "held_by_checkout" };

  return { ok: true, variantId: chosen.variantId, label: chosen.label, minSubtotalCents: chosen.minSubtotalCents };
}
