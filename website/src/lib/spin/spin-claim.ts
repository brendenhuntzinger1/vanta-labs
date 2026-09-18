import "server-only";

import crypto from "node:crypto";

import { hashOfferToken } from "@/lib/offers/customer-offers";
import { supabaseAdmin } from "@/lib/supabase-server";
import { SPIN_PRIZES, prizeForOfferRow, type SpinPrize } from "@/lib/spin/prize-table";
import { spinOfferKey } from "@/lib/spin/spin-service";

// ---------------------------------------------------------------------------
// GETTING YOUR PRIZE ONTO THE DEVICE YOU ACTUALLY BUY FROM.
//
// The prize travels in an httpOnly cookie holding a bearer token. Spin on a
// phone, buy on a laptop, and that laptop has no cookie — so without this the
// prize silently is not there, which is the single most likely way this feature
// disappoints someone.
//
// WHY NOT JUST LOOK THE OFFER UP DURING PRICING. Because customer_offer_reserve
// is keyed on the token HASH, and only the hash is stored — a row found by
// email cannot reserve itself, so it could be priced into a quote and then fail
// to be held at order creation. Two orders could be quoted the same gift.
//
// WHY NOT DO IT INSIDE quoteOrder. quoteOrder is a PURE PRICING PASS and is
// called several times per checkout — the preview, the authoritative total, and
// the anti-tamper re-quotes on the express lane. Anything with a side effect
// belongs outside it, and re-issuing a bearer token is very much a side effect.
//
// SO: this claims the offer for a VERIFIED account and re-issues the cookie,
// once, deliberately, outside pricing. Everything downstream — quoteOrder, the
// reservation, redemption — is untouched and keeps working exactly as it did.
//
// THE IDENTITY IS THE SESSION, NEVER A TYPED ADDRESS. The caller passes an
// email it got from getAuthenticatedUser(), which is verified against the auth
// backend. A checkout form's email field is supplied by the browser and would
// let anyone claim anyone's prize by typing their address.
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;

export type ClaimedSpin = {
  prize: SpinPrize;
  sliceIndex: number;
  expiresAt: string;
  /** A freshly minted bearer token for this device's cookie. */
  offerToken: string;
  /** The minimum from the OFFER ROW — the rung this customer actually holds. */
  minSubtotalCents: number;
  /** The dose they chose, when the prize has a ladder. */
  variantId: string | null;
};

type Row = {
  id: string;
  reward_kind: string;
  product_slug: string | null;
  variant_id: string | null;
  percent_off: number | null;
  min_subtotal_cents: number | null;
  expires_at: string;
  reserved_order_id: string | null;
  reserved_at: string | null;
};

/**
 * How long a reservation is respected before it is treated as abandoned.
 * Matches the database default used by customer_offer_reserve.
 */
const OFFER_HOLD_SECONDS = 1800;

/**
 * Re-issue this account's live spin prize to the current device.
 *
 * Returns null when there is nothing to claim: no spin, an expired or revoked
 * one, a prize already spent, or a prize a live checkout is holding.
 *
 * ROTATING THE TOKEN IS THE POINT, and it has a consequence worth stating: the
 * device that span loses its cookie's validity. That is the correct trade —
 * one live bearer secret per offer means a screenshot of an old link cannot be
 * spent later, and the original device re-claims the same way this one just did
 * as long as it is signed in.
 */
export async function claimSpinForAccount(input: {
  /** MUST come from getAuthenticatedUser(). Never from a request body. */
  verifiedEmail: string;
  campaignId: string;
  now?: number;
}): Promise<ClaimedSpin | null> {
  const email = String(input.verifiedEmail ?? "").trim().toLowerCase();
  const campaignId = String(input.campaignId ?? "").trim();
  if (!email || !email.includes("@") || !campaignId) return null;

  const now = input.now ?? Date.now();

  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select("id, reward_kind, product_slug, variant_id, percent_off, min_subtotal_cents, expires_at, reserved_order_id, reserved_at")
    .eq("offer_key", spinOfferKey(campaignId))
    .eq("email", email)
    .is("revoked_at", null)
    .is("redeemed_at", null)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as Row;

  // An expired prize is not claimable, and must not be re-issued into a cookie
  // that would then be refused at the till.
  if (new Date(row.expires_at).getTime() <= now) return null;

  // A LIVE CHECKOUT IS HOLDING IT. Rotating now would invalidate the token that
  // checkout is pricing with, so the customer's own in-flight order would lose
  // the gift between the quote and the charge. Leave it alone; the hold lapses
  // on its own.
  const heldAt = row.reserved_at ? new Date(row.reserved_at).getTime() : 0;
  if (row.reserved_order_id && heldAt > now - OFFER_HOLD_SECONDS * 1000) return null;

  const prize = prizeForOfferRow(row);
  // A live offer this wheel did not mint — a cart-recovery gift, say — is not
  // this feature's to re-issue. Claiming it here would quietly change how an
  // existing promotion reaches the customer.
  if (!prize) return null;

  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  // Guarded on the same conditions that were just read, so a redemption or a
  // reservation landing between the read and this write wins rather than being
  // overwritten.
  const { error: rotateError } = await supabaseAdmin
    .from("customer_offers")
    .update({ token_hash: hashOfferToken(token) })
    .eq("id", row.id)
    .is("revoked_at", null)
    .is("redeemed_at", null);

  if (rotateError) {
    console.error("[spin] unable to re-issue the prize to this device", rotateError.message);
    return null;
  }

  return {
    prize,
    sliceIndex: SPIN_PRIZES.indexOf(prize),
    expiresAt: row.expires_at,
    offerToken: token,
    // THE ROW'S MINIMUM TRAVELS WITH THE PRIZE to the second device. Without
    // it the laptop would quote the prize table's entry rung while the till
    // enforced whichever rung this customer chose on their phone.
    minSubtotalCents: typeof row.min_subtotal_cents === "number" ? row.min_subtotal_cents : prize.minSubtotalCents,
    variantId: row.variant_id ?? null,
  };
}

