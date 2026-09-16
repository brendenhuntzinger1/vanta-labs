import "server-only";

import crypto from "node:crypto";

import { hashOfferToken } from "@/lib/offers/customer-offers";
import { supabaseAdmin } from "@/lib/supabase-server";
import { SPIN_PRIZES, SPIN_TTL_DAYS, drawSpinPrize, prizeForOfferRow, type SpinPrize } from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// ONE SPIN PER ADDRESS PER CAMPAIGN, AND WHY THIS DOES ITS OWN INSERT.
//
// The obvious implementation is issueResolvedOffer, which mints exactly this
// row and is already hardened. It is the wrong call here, for a reason that
// only shows up on a wheel: when the one-live-offer index refuses an insert,
// issueResolvedOffer RETIRES the blocking row and mints a fresh one.
//
// That is correct where it lives. A win-back whose token was lost in a failed
// send must be re-sendable, or the customer gets an email promising a gift with
// nothing behind it. But the same behaviour on a wheel is a re-roll: POST
// twice, and the second draw revokes the first prize and replaces it. Anyone
// who can press a button twice spins until they like the answer, and the
// jackpot is a $119.99 vial.
//
// So this service reads first and never reissues. A unique violation is not an
// obstacle to clear — it IS the answer, and the answer is "you already span".
// That also makes the race safe: two requests can both pass the read, only one
// insert survives, and the loser reports the winner's prize.
//
// THE OFFER ROW IS THE LEDGER. There is no spin table. The row records the
// reward, the minimum and the expiry, and the wedge is recovered from the
// reward by prizeForOfferRow — so a token minted today still means what it
// meant even if the prize table is edited inside its 72 hours.
// ---------------------------------------------------------------------------

/** Bearer-secret length, matching customer-offers.ts. */
const TOKEN_BYTES = 32;

/**
 * The offer key one campaign's spins file under.
 *
 * Namespaced so it can never collide with an OFFER_CATALOG key or with
 * `campaign:` gifts, and carrying the campaign id so the index gives one spin
 * per campaign rather than one ever — this promotion is meant to be re-run, and
 * a customer who span in Q4 is a fresh spinner in Q1.
 *
 * Every consumer outside customer-offers.ts treats offer_key as an opaque
 * string (quoteOrder types it `string`), so a key outside the catalogue costs
 * nothing downstream.
 */
export function spinOfferKey(campaignId: string): string {
  return `spin:${String(campaignId ?? "").trim()}`;
}

export type SpinResult = {
  prize: SpinPrize;
  /** Where the wheel must stop. Index into SPIN_PRIZES, which is wedge order. */
  sliceIndex: number;
  expiresAt: string;
  /**
   * The offer token — ONLY on the call that minted it, and null on every read
   * afterwards. It is a bearer secret, so it is handed over once, goes straight
   * into an httpOnly cookie, and is never returned again. A returning visitor
   * is shown their prize from the row and keeps using the cookie they already
   * hold.
   */
  offerToken: string | null;
  alreadySpun: boolean;
};

const ROW_COLUMNS = "id, offer_key, email, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at, revoked_at, redeemed_at";

type OfferRow = {
  reward_kind: string;
  product_slug: string | null;
  percent_off: number | null;
  expires_at: string;
};

function resultFromRow(row: OfferRow): SpinResult | null {
  const prize = prizeForOfferRow(row);
  // A live offer this wheel did not mint — a cart-recovery gift, say — is not a
  // spin. Animating to a wedge for it would show a prize nobody span for.
  if (!prize) return null;
  return {
    prize,
    sliceIndex: SPIN_PRIZES.indexOf(prize),
    expiresAt: row.expires_at,
    offerToken: null,
    alreadySpun: true,
  };
}

/**
 * What this address already won in this campaign, if anything.
 *
 * A REDEEMED SPIN STILL COUNTS AS A SPIN. They used it; they do not get
 * another. Only a revoked row is ignored, which is how support hands somebody a
 * fresh spin after a genuine problem.
 */
export async function readExistingSpin(input: {
  email: string;
  campaignId: string;
}): Promise<SpinResult | null> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const offerKey = spinOfferKey(input.campaignId);
  if (!email || !offerKey) return null;

  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select(ROW_COLUMNS)
    .eq("offer_key", offerKey)
    .eq("email", email)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return null;
  return resultFromRow(data as OfferRow);
}

/**
 * Spin, or report the spin that already happened.
 *
 * Returns null only when the address or campaign is unusable, or the write
 * failed for a reason that is not the index. A caller that gets null should say
 * so plainly rather than silently rendering an unspun wheel — a wheel that
 * cannot mint must not look like one that can.
 */
export async function spin(input: {
  email: string;
  campaignId: string;
  now?: number;
  /** Injected for tests. Defaults to the CSPRNG draw in prize-table.ts. */
  randomInt?: (boundExclusive: number) => number;
}): Promise<SpinResult | null> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const campaignId = String(input.campaignId ?? "").trim();
  if (!email || !email.includes("@") || !campaignId) return null;

  const existing = await readExistingSpin({ email, campaignId });
  if (existing) return existing;

  const now = input.now ?? Date.now();
  const prize = drawSpinPrize(input.randomInt);
  const expiresAt = new Date(now + SPIN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  const reward = prize.reward;
  const { error } = await supabaseAdmin.from("customer_offers").insert({
    offer_key: spinOfferKey(campaignId),
    token_hash: hashOfferToken(token),
    email,
    // The row records what was PROMISED. Nothing downstream resolves the key
    // back to a prize table, which is what lets a spin from last week redeem
    // through the identical path as one from today.
    reward_kind: reward.kind,
    product_slug: reward.kind === "free_product" ? reward.productSlug : null,
    percent_off: reward.kind === "percent" ? reward.percent : null,
    // Null where there is no product half, so the reward-shape CHECK can say
    // "a count only where there is something to count".
    ...(reward.kind === "free_product" ? { quantity: 1 } : {}),
    min_subtotal_cents: prize.minSubtotalCents,
    expires_at: expiresAt,
    created_at: new Date(now).toISOString(),
  });

  if (error) {
    // 23505 IS THE ANSWER, NOT AN ERROR TO RECOVER FROM. Someone else's insert
    // won the race, or this address span in another tab. Read their prize and
    // report it; do not clear the row and mint over it.
    if (error.code === "23505") {
      const winner = await readExistingSpin({ email, campaignId });
      if (winner) return winner;
    }
    console.error("[spin] unable to mint the prize", spinOfferKey(campaignId), error.message);
    return null;
  }

  return {
    prize,
    sliceIndex: SPIN_PRIZES.indexOf(prize),
    expiresAt,
    offerToken: token,
    alreadySpun: false,
  };
}
