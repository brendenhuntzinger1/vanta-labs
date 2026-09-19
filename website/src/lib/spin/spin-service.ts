import "server-only";

import crypto from "node:crypto";

import { hashOfferToken } from "@/lib/offers/customer-offers";
import { supabaseAdmin } from "@/lib/supabase-server";
import { SPIN_PRIZES, SPIN_TTL_DAYS, drawSpinPrize, prizeForOfferRow, type SpinPrize } from "@/lib/spin/prize-table";
import { spinOfferKey } from "@/lib/spin/offer-key";

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

// The key's shape lives in offer-key.ts, a pure module quoteOrder can import
// without dragging this file's supabase client and `server-only` with it.
export { spinOfferKey, isSpinOfferKey } from "@/lib/spin/offer-key";

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
  /**
   * Already spent on an order.
   *
   * A REDEEMED SPIN IS STILL A SPIN — readExistingSpin deliberately keeps the
   * row so nobody gets a second go — but the two are not the same thing to the
   * customer, and the page had no way to tell them apart. It showed a redeemed
   * prize with a running countdown and a "Start shopping" button, inviting
   * someone to go and spend a reward that was already on an order they placed.
   */
  redeemed: boolean;
  /**
   * THE MINIMUM THIS CUSTOMER MUST ACTUALLY CLEAR, from the offer row.
   *
   * Not `prize.minSubtotalCents`. Once a prize has a ladder the table can only
   * state the entry rung, while the till enforces `offer.min_subtotal_cents` —
   * so reading the table here would let the wheel advertise $90 at a checkout
   * demanding $170. Every surface that shows a number to a customer who has
   * already spun must use this one.
   */
  minSubtotalCents: number;
  /** The dose the customer chose, when this prize has a ladder. */
  variantId: string | null;
  /**
   * The prize was retired by a cycle close and can no longer be redeemed.
   *
   * Only ever true for a row minted before close-cycle learned to spare spin
   * prizes. It is surfaced rather than hidden because the alternative — showing
   * a dead prize with a live countdown — sends someone to a checkout that will
   * refuse them with no explanation.
   */
  cycleClosed?: boolean;
};

const ROW_COLUMNS = "id, offer_key, email, reward_kind, product_slug, variant_id, percent_off, min_subtotal_cents, expires_at, revoked_at, revoke_reason, redeemed_at";

type OfferRow = {
  reward_kind: string;
  product_slug: string | null;
  variant_id?: string | null;
  percent_off: number | null;
  min_subtotal_cents?: number | null;
  expires_at: string;
  redeemed_at?: string | null;
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
    redeemed: Boolean(row.redeemed_at),
    // THE ROW WINS. Falling back to the table is only for a row minted before
    // the column carried a value; a laddered prize always writes its own.
    minSubtotalCents: typeof row.min_subtotal_cents === "number"
      ? row.min_subtotal_cents
      : prize.minSubtotalCents,
    variantId: row.variant_id ?? null,
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

  // ONE ROUND TRIP, NOT TWO. This runs for every visitor who has not spun —
  // the commonest case on the page — so the cycle-closed check rides along in
  // the same query rather than costing a second lookup that almost always
  // finds nothing.
  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select(ROW_COLUMNS)
    .eq("offer_key", offerKey)
    .eq("email", email)
    // A CYCLE-CLOSED PRIZE STILL COUNTS AS A SPIN.
    //
    // close_cycle used to revoke spin rows along with the retention ladder (it
    // no longer does — see customer-offers.sql). A row it caught before that
    // fix would be invisible to a plain `revoked_at is null` read, and the
    // wheel would draw again: the one-live-offer index is partial on
    // `revoked_at is null and redeemed_at is null`, so the replacement insert
    // would succeed and the customer would hold a second, freshly drawn prize.
    //
    // Narrow on purpose. An OPERATOR revocation still grants a fresh spin —
    // that is how support fixes a genuine problem, and spin-one-spin.db.test.ts
    // pins it. Only the automatic reason disqualifies, because the customer
    // never asked for it.
    .or("revoked_at.is.null,revoke_reason.eq.cycle_closed")
    .order("issued_at", { ascending: false })
    .limit(2);

  if (error || !data?.length) return null;

  // A live row always wins over a cycle-closed one: the customer may have been
  // handed a fresh spin by support after the old prize was swept.
  const rows = data as Array<OfferRow & { revoked_at?: string | null }>;
  const live = rows.find((row) => !row.revoked_at);
  if (live) return resultFromRow(live);

  const result = resultFromRow(rows[0]);
  return result ? { ...result, cycleClosed: true } : null;
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
    // The ceiling on a percentage's cash value. Written onto the row so the
    // cap a customer was promised is the cap the till applies, even if the
    // prize table is edited inside the offer's 72 hours.
    ...(prize.maxDiscountCents ? { max_discount_cents: prize.maxDiscountCents } : {}),
    // Null where there is no product half, so the reward-shape CHECK can say
    // "a count only where there is something to count".
    ...(reward.kind === "free_product" ? { quantity: 1 } : {}),
    min_subtotal_cents: prize.minSubtotalCents,
    expires_at: expiresAt,
    // `issued_at`, not `created_at`: this table names it the former and has no
    // column by the latter. Written explicitly rather than left to the now()
    // default so an injected clock is honoured end to end.
    issued_at: new Date(now).toISOString(),
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
    // A LADDERED PRIZE IS MINTED UNCHOSEN, AT ITS ENTRY RUNG.
    //
    // `variant_id` stays null until the customer picks, and null is exactly
    // what quoteOrder already resolves to the catalogue's default dose — which
    // is the entry dose on all four ladders. So an abandoned picker still
    // leaves a prize that redeems, at the minimum it was minted with, with no
    // catalogue read in the mint path and no new way for a spin to fail.
    //
    // THE INVARIANT THAT KEEPS THOSE TWO IN STEP IS NOT BUILD-ENFORCED, and
    // this comment used to say it was — "enforced in prize-table.test.ts
    // against the live catalogue". That file makes no catalogue read at all,
    // and no test in the repo does: the suite runs without Supabase, so an
    // invariant about LIVE data cannot break the build here.
    //
    // What is checked: prize-table.test.ts pins each ladder's rungs, prices and
    // minimums, and cheapest-first ordering, so entry rung == doses[0] cannot
    // drift in the code. What is NOT checked is the other half — that the
    // catalogue's is_default for that product is still the same dose. An admin
    // flipping is_default on glp-1 from 5mg to 10mg would silently ship the
    // larger vial against the entry rung's $90 minimum, with nothing said.
    //
    // Verified by hand against production on 2026-09-19 (all four ladders:
    // glp-1 5mg, glp-2 5mg, glp-3 5mg, hgh-gh-191 24iu are is_default). It
    // belongs in the admin dose editor, which is where the flip happens.
    variantId: null,
    minSubtotalCents: prize.minSubtotalCents,
    alreadySpun: false,
    // Just minted, so it cannot have been spent.
    redeemed: false,
  };
}
