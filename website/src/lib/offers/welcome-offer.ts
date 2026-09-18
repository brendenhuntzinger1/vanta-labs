import "server-only";

import { PAID_ORDER_STATUSES, isProductPurchaseOrder } from "@/lib/ledger";
import { ensureContactCode, findLiveContactCode } from "@/lib/marketing/omnisend/codes";
import { getSmsSignupConfig } from "@/lib/admin-control";
import { isHeldOut } from "@/lib/offers/welcome-offer-holdout";
import { readSmsStanding, recordSmsConsent, type SmsConsentSource } from "@/lib/sms-consent";
import { acceptableSmsPhone } from "@/lib/sms-consent-text";
import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// THE WELCOME DISCOUNT IS RETIRED. THE SPIN WHEEL IS THE ACQUISITION OFFER.
//
// NARROW ON PURPOSE. The kind is what identifies it — CONTACT_CODE_OFFERS has
// three, and two of them must carry on untouched:
//
//   welcome  15%  <- retired here, and here only
//   winback  15%  <- a different offer that happens to share the number
//   recovery 10%  <- cart recovery
//
// So this flag gates the two calls that MINT a welcome code and nothing else.
// findLiveContactCode("welcome", …) is deliberately left alone: a code already
// in a customer's hands keeps working to its own expiry, at the checkout, on
// the terms they were given. Retiring an incentive is not the same as
// confiscating what it already bought, and a customer holding a live code has
// done nothing wrong.
//
// A CONSTANT RATHER THAN A CONFIG TOGGLE. sms_signup.prompts_enabled already
// exists and already suppresses the prompts, but it is an operator switch that
// can be flipped back — which would quietly resume minting an offer the store
// no longer advertises anywhere. This is a product decision, so it lives in
// the code where reversing it is a reviewed change.
// ---------------------------------------------------------------------------
export const WELCOME_OFFER_RETIRED = true;


/**
 * THE ONE PLACE THE WELCOME OFFER IS DECIDED.
 *
 * Five surfaces show it — the sign-up page, the catalogue bar, a product
 * page's link, the cart card and the checkout box — and every one of them
 * asks this module rather than working it out again. That is the whole point:
 * the owner's rules are "no duplicate codes, no restarted expiration, and
 * never show it to someone who has already bought", and rules enforced in
 * five places are rules enforced in four.
 *
 * ELIGIBILITY IS ONE QUESTION: has this address ever paid for a product? The
 * orders read is the marketing sync's (contacts.ts readOrders) — paid
 * statuses from the ledger, then the product-purchase filter, so a
 * replacement or a shipping-label order never counts as a first order. One
 * matching row is enough, so the query stops at one.
 *
 * MINTING IS ensureContactCode's JOB AND ONLY ITS JOB. It hands back the live
 * code when there is one and mints only when there is not, which is exactly
 * "no duplicates, no restarted expiry" — so this module never inserts a
 * coupon row itself and never computes an end date.
 *
 * NOT GATED ON OMNISEND. The Omnisend hooks are gated (production plus a
 * key); the store's own offer is not, because the shopper is standing at the
 * till and the code has to exist now. Omnisend learns of the consent
 * afterwards through recordSmsConsent's own deferral.
 *
 * Never throws. Every caller is a page render or a checkout request, and no
 * catalogue, cart or payment may fail over a marketing discount.
 */

const LOG = "[welcome-offer]";

/**
 * WHAT THIS PERSON MAY BE SHOWN, AND WHETHER THEY MAY BE INTERRUPTED.
 *
 * Five surfaces ask this one question, so the answer carries both halves:
 * what to render, and whether the main invitation is allowed to open over the
 * page. They are different questions and conflating them is how a shopper who
 * already said no gets asked again.
 *
 *   eligible   never bought, holds no code, never subscribed or opted out.
 *              The 15% invitation, and the modal may interrupt.
 *   claimed    holds a live code. Show the code, never another sign-up ask.
 *   returning  has paid for a product order. NEVER a first-order discount;
 *              a plain invitation to the text list is still fair.
 *   suppressed subscribed already with no offer to give, or nothing to say.
 *              No acquisition prompt of any kind.
 *
 * An address that once opted out and never bought is `eligible` but is NOT
 * interruptible: the quiet placements may still ask (an unticked box is fresh
 * explicit consent, which is what a resubscribe needs), while a modal over the
 * page of someone who already said stop is not something this store does.
 */
export type WelcomeOfferStatus = "eligible" | "claimed" | "returning" | "suppressed";

export type WelcomeOffer = {
  status: WelcomeOfferStatus;
  /** Present only on `claimed`. */
  code?: string;
  endsAt?: string;
  percent?: number;
  /** May the main invitation open over the page for this person? */
  mayInterrupt: boolean;
};


export type WelcomeClaimFailure = "phone" | "ineligible" | "consent" | "code";

export type WelcomeClaim =
  | { ok: true; code: string; endsAt: string; percent: number }
  /**
   * Consent recorded, no discount — the shape every new sign-up takes now that
   * the welcome code is retired. Distinct from the failure branch because
   * nothing went wrong: the subscriber is on the list, there is simply no
   * coupon to hand back. Callers that used to print a code must read this and
   * say so rather than reporting an error the customer did not cause.
   */
  | { ok: true; subscribedOnly: true }
  | { ok: false; reason: WelcomeClaimFailure };

function normalizeEmail(email: string | null | undefined): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

/**
 * Has this address ever paid for a product order? A refused read answers
 * `true` — the safe direction, because the cost of a wrong `false` is a
 * second welcome discount for a repeat customer, and the cost of a wrong
 * `true` is that a first-time buyer is not shown an offer for one page load.
 */
export async function hasPurchased(email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  if (!address) return true;
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_type, replacement_of")
      .eq("customer_email", address)
      .in("payment_status", Array.from(PAID_ORDER_STATUSES))
      .limit(50);
    if (error) {
      console.error(LOG, "orders read refused", error.message);
      return true;
    }
    return ((data ?? []) as { order_type?: string | null; replacement_of?: string | null }[])
      .some((row) => isProductPurchaseOrder(row));
  } catch (error) {
    console.error(LOG, "orders read failed", error);
    return true;
  }
}

/**
 * What this address may be shown right now. Reads only: a page render never
 * mints, so merely opening the catalogue cannot start someone's fourteen days
 * ticking. The code appears here only once they have actually asked for it.
 *
 * Order matters. A live code wins over everything, including a purchase,
 * because a code held while an order is being paid for is still theirs until
 * the order retires it. Then a purchase, which permanently ends the
 * first-order discount. Then the text list.
 */
export async function readWelcomeOffer(email: string | null | undefined): Promise<WelcomeOffer> {
  const address = normalizeEmail(email);
  if (!address) return { status: "suppressed", mayInterrupt: false };

  const live = await findLiveContactCode("welcome", address);
  if (live) {
    return { status: "claimed", code: live.code, endsAt: live.endsAt, percent: live.percent, mayInterrupt: false };
  }

  const [bought, sms, config] = await Promise.all([
    hasPurchased(address),
    readSmsStanding(address),
    getSmsSignupConfig(),
  ]);

  // THE HOLDOUT, when one is running. Held-back shoppers see no prompt
  // anywhere, which is what makes the comparison against everyone else mean
  // something. Nobody is held back at the default of 0.
  if (isHeldOut(address, config.holdoutPercent)) return { status: "suppressed", mayInterrupt: false };
  if (bought) {
    // Never a discount. An invitation with nothing attached is still fair, and
    // only for someone who is not already on the list.
    return { status: sms === "subscribed" ? "suppressed" : "returning", mayInterrupt: false };
  }
  if (sms === "subscribed") {
    // On the list, never bought, and no live code: the offer has already been
    // spent or has expired. Nothing left to acquire.
    return { status: "suppressed", mayInterrupt: false };
  }
  // Never bought and not on the list. The offer is open. Someone who opted out
  // before may be asked quietly, never interrupted.
  return { status: "eligible", mayInterrupt: sms === "none" };
}

/**
 * SUBSCRIBING ALWAYS WORKS. THE DISCOUNT IS THE CONDITIONAL PART.
 *
 * The consent is recorded before eligibility is even considered, and a
 * returning buyer who ticks the box is subscribed like anyone else — they
 * simply get `ineligible` back for the offer. Refusing the subscription
 * because the discount does not apply would throw away the customer to
 * protect the coupon, which is backwards.
 *
 * IDEMPOTENT BY CONSTRUCTION. Someone who already holds a live code gets that
 * same code back with its original end date, whether they tick the box again
 * at the checkout or claimed it from the catalogue a week ago. That is the
 * owner's "no duplicate codes, no restarted expiration", and it falls out of
 * ensureContactCode rather than being bolted on.
 *
 * A code is refused if the consent row was refused: a discount handed out for
 * a subscription that was never recorded is a discount with no subscriber
 * behind it, and the consent record is the thing that has to be true.
 */
export async function claimWelcomeOffer(input: {
  email: string;
  phone: string;
  source: SmsConsentSource;
  userId?: string | null;
}): Promise<WelcomeClaim> {
  const address = normalizeEmail(input.email);
  const phone = acceptableSmsPhone(input.phone);
  if (!address || !phone) return { ok: false, reason: "phone" };

  const consented = await recordSmsConsent({ email: address, phone, source: input.source, userId: input.userId ?? null });
  if (!consented) return { ok: false, reason: "consent" };

  // The live code is checked BEFORE eligibility on purpose: an address that
  // holds a code and then buys something keeps that code until the order
  // retires it, and the checkout must still be able to hand it back while the
  // order is being paid for.
  const live = await findLiveContactCode("welcome", address);
  if (live) return { ok: true, code: live.code, endsAt: live.endsAt, percent: live.percent };

  // THE WELCOME DISCOUNT IS RETIRED. Consent above still lands; no new code is
  // minted below it. See WELCOME_OFFER_RETIRED.
  if (WELCOME_OFFER_RETIRED) return { ok: true, subscribedOnly: true };

  if (await hasPurchased(address)) return { ok: false, reason: "ineligible" };

  const code = await ensureContactCode("welcome", address);
  if (!code) return { ok: false, reason: "code" };
  return { ok: true, code: code.code, endsAt: code.endsAt, percent: code.percent };
}

/**
 * CONSENT WITHOUT A DISCOUNT, for the period before the carriers approve this
 * store's use case.
 *
 * The kill switch (admin-control.ts getSmsSignupConfig) hides every incentive
 * prompt, but the plain subscribe boxes stay, and a tick on one of them has to
 * land somewhere. This is that path: the same consent row, the same Omnisend
 * push, and no coupon minted for an offer nobody is being shown.
 */
export async function recordSmsSignupOnly(input: {
  email: string;
  phone: string;
  source: SmsConsentSource;
  userId?: string | null;
}): Promise<boolean> {
  const address = normalizeEmail(input.email);
  const phone = acceptableSmsPhone(input.phone);
  if (!address || !phone) return false;
  return recordSmsConsent({ email: address, phone, source: input.source, userId: input.userId ?? null });
}

/**
 * A NEW TEXT SUBSCRIBER'S CODE, MINTED WHERE THE CONSENT WAS TAKEN.
 *
 * The sign-up page and the account settings page record SMS consent through
 * their own routes rather than through claimWelcomeOffer, so this is the half
 * they call afterwards: eligibility, then ensureContactCode, then nothing.
 * Silent by design — a sign-up must not fail, slow down or report differently
 * because a discount code could not be written.
 *
 * It is the reason the offer can be advertised as a text-subscriber offer at
 * all: minting lives on the SMS path and nowhere else, so an email
 * subscription no longer produces a welcome code (hooks.ts onMarketingOptIn).
 */
export async function grantWelcomeOfferForConsent(email: string): Promise<void> {
  if (WELCOME_OFFER_RETIRED) return;
  const address = normalizeEmail(email);
  if (!address) return;
  try {
    if (await findLiveContactCode("welcome", address)) return;
    if (await hasPurchased(address)) return;
    await ensureContactCode("welcome", address);
  } catch (error) {
    console.error(LOG, "welcome code could not be granted", error);
  }
}
