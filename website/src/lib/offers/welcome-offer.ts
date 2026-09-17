import "server-only";

import { PAID_ORDER_STATUSES, isProductPurchaseOrder } from "@/lib/ledger";
import { ensureContactCode, findLiveContactCode } from "@/lib/marketing/omnisend/codes";
import { recordSmsConsent, type SmsConsentSource } from "@/lib/sms-consent";
import { acceptableSmsPhone } from "@/lib/sms-consent-text";
import { supabaseAdmin } from "@/lib/supabase-server";

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

export type WelcomeOffer =
  /** Never bought, holds no live code: the offer is open to them. */
  | { status: "eligible" }
  /** Holds a live code — shown, never re-minted, never re-dated. */
  | { status: "claimed"; code: string; endsAt: string; percent: number }
  /** Has already bought, or the address is unusable: show nothing. */
  | { status: "ineligible" };

export type WelcomeClaimFailure = "phone" | "ineligible" | "consent" | "code";

export type WelcomeClaim =
  | { ok: true; code: string; endsAt: string; percent: number }
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
 */
export async function readWelcomeOffer(email: string | null | undefined): Promise<WelcomeOffer> {
  const address = normalizeEmail(email);
  if (!address) return { status: "ineligible" };
  const live = await findLiveContactCode("welcome", address);
  if (live) return { status: "claimed", code: live.code, endsAt: live.endsAt, percent: live.percent };
  return (await hasPurchased(address)) ? { status: "ineligible" } : { status: "eligible" };
}

/**
 * Subscribe this address to texts and hand back its welcome code.
 *
 * IDEMPOTENT BY CONSTRUCTION. Someone who already holds a live code gets that
 * same code back with its original end date, whether they tick the box again
 * at the checkout or claimed it from the catalogue a week ago. That is the
 * owner's "existing subscribers use their existing code without signing up
 * again", and it falls out of ensureContactCode rather than being bolted on.
 *
 * CONSENT FIRST, CODE SECOND, and the code is refused if the consent row was.
 * A discount handed out for a subscription that was never recorded is a
 * discount with no subscriber behind it, and the TCPA record is the thing
 * that has to be true.
 */
export async function claimWelcomeOffer(input: {
  email: string;
  phone: string;
  source: SmsConsentSource;
  userId?: string | null;
}): Promise<WelcomeClaim> {
  const address = normalizeEmail(input.email);
  const phone = acceptableSmsPhone(input.phone);
  if (!address) return { ok: false, reason: "phone" };
  if (!phone) return { ok: false, reason: "phone" };

  // The live code is checked BEFORE eligibility on purpose: an address that
  // holds a code and then buys something keeps that code until the order
  // retires it (order-hooks.ts), and the checkout must still be able to hand
  // it back while the order is being paid for.
  const live = await findLiveContactCode("welcome", address);
  if (!live && (await hasPurchased(address))) return { ok: false, reason: "ineligible" };

  const consented = await recordSmsConsent({ email: address, phone, source: input.source, userId: input.userId ?? null });
  if (!consented) return { ok: false, reason: "consent" };

  const code = live ?? (await ensureContactCode("welcome", address));
  if (!code) return { ok: false, reason: "code" };
  return { ok: true, code: code.code, endsAt: code.endsAt, percent: code.percent };
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
