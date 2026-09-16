import "server-only";

import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Per-contact discount codes for Omnisend's emails (spec §3.4).
 *
 * Omnisend only generates unique codes for Shopify, WooCommerce and
 * BigCommerce, so for this store the SITE mints the code, binds it to the
 * address and hands it to Omnisend as a contact property. The row shape is the
 * cart-recovery minter's (cart-recovery.ts mintCartRecoveryCoupon) plus
 * `is_private`, because that is the shape `validateCoupon` already knows how
 * to refuse for any other address, and `is_private` keeps the code off the
 * storefront's promo banner and coupon listings.
 *
 * One live code per kind per address. A contact who already holds a live
 * welcome code is handed the same one again, never a second, so the number in
 * the email and the number in the database can never disagree (K-05).
 *
 * Never throws: every caller is a marketing hook on a request path or inside
 * after(), and no order, checkout or page may fail over a discount code.
 */

export const CONTACT_CODE_OFFERS = {
  welcome: { percent: 10, ttlHours: 14 * 24, source: "omnisend_welcome", prefix: "VLWELCOME" },
  winback: { percent: 15, ttlHours: 14 * 24, source: "omnisend_winback", prefix: "VLBACK" },
  recovery: { percent: 10, ttlHours: 5 * 24, source: "omnisend_recovery", prefix: "VLCART" },
} as const;

export type ContactCodeKind = keyof typeof CONTACT_CODE_OFFERS;

export type ContactCode = {
  code: string;
  endsAt: string;
  /** The percentage the coupon row actually carries — read back, never remembered. */
  percent: number;
};

const HOUR_MS = 60 * 60 * 1000;
/**
 * 32 symbols: uppercase letters and digits without 0/O/1/I, which are the
 * pairs people misread when typing a code from an email. Exactly 32 so a
 * byte modulo the alphabet length draws every symbol equally.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** Draws before giving up on a unique-code collision (32^6 ≈ a billion codes). */
const MINT_ATTEMPTS = 3;

function normalizeEmail(email: string): string {
  return String(email ?? "").trim().toLowerCase();
}

function generateContactCode(prefix: string): string {
  const bytes = randomBytes(CODE_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `${prefix}-${suffix}`;
}

type LiveCodeRow = {
  code?: string | null;
  ends_at?: string | null;
  redemptions_count?: number | null;
  max_redemptions?: number | null;
  discount_value?: number | string | null;
  discount_type?: string | null;
};

/**
 * The percentage a live row carries. Read back rather than remembered, for
 * the reason cart-recovery.ts findLiveCouponForCart gives: a code minted at
 * 15% is described as 15% even if the band has since been edited to 10%.
 */
function percentOf(row: LiveCodeRow): number {
  if (String(row.discount_type ?? "percent") === "percent") {
    return Math.max(0, Math.round(Number(row.discount_value ?? 0) || 0));
  }
  return 0;
}

/**
 * A whole percentage inside 1..100, or the fallback. A band's percentage is
 * operator-typed configuration, and "100" here is a free order.
 */
function boundedPercent(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(1, Math.round(parsed)));
}

/**
 * The live code this address already holds for this kind, or null.
 *
 * Live means the checkout will still honour it: bound to this address, from
 * this offer, active, unexpired and not already spent. A redeemed single-use
 * code is still `active` in the row; only its count says it is gone, so that
 * last check happens here rather than in the query. Newest first, because the
 * invariant this module keeps — one live code per kind per address — means
 * the newest is the only one that can be live.
 */
export async function findLiveContactCode(kind: ContactCodeKind, email: string): Promise<ContactCode | null> {
  const offer = CONTACT_CODE_OFFERS[kind];
  const address = normalizeEmail(email);
  if (!address) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("coupons")
      .select("code, ends_at, redemptions_count, max_redemptions, discount_value, discount_type")
      .eq("assigned_email", address)
      .eq("source", offer.source)
      .eq("active", true)
      .gt("ends_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.error("[omnisend/codes] live code lookup refused", { kind, message: error.message });
      return null;
    }
    const row = ((data ?? []) as LiveCodeRow[])[0];
    if (!row?.code || !row.ends_at) return null;
    const unspent = row.max_redemptions === null || row.max_redemptions === undefined
      || Number(row.redemptions_count ?? 0) < Number(row.max_redemptions);
    return unspent ? { code: String(row.code), endsAt: String(row.ends_at), percent: percentOf(row) } : null;
  } catch (error) {
    console.error("[omnisend/codes] live code lookup failed", { kind, error });
    return null;
  }
}

/**
 * Every live code this address holds, by kind. Read, never minted, so a
 * contact upsert reports what is real. A kind with no live code is absent.
 */
export async function findLiveContactCodes(email: string): Promise<Partial<Record<ContactCodeKind, ContactCode>>> {
  const kinds = Object.keys(CONTACT_CODE_OFFERS) as ContactCodeKind[];
  const found = await Promise.all(kinds.map((kind) => findLiveContactCode(kind, email)));
  const codes: Partial<Record<ContactCodeKind, ContactCode>> = {};
  kinds.forEach((kind, index) => {
    const code = found[index];
    if (code) codes[kind] = code;
  });
  return codes;
}

/**
 * The code to put in this contact's property: the live one if there is one,
 * otherwise a fresh mint. Null only when the database refused both, and the
 * caller then sends "" so Omnisend hides the offer section (spec §3.4).
 *
 * `options.percent` mints at a caller-chosen percentage — the cart-offer
 * sweep passes the cart's value band — and defaults to the offer's own. A
 * live code is re-offered at whatever percentage IT carries, because one
 * address holds one live code per kind and the email must describe that one.
 */
export async function ensureContactCode(kind: ContactCodeKind, email: string, options: { percent?: number } = {}): Promise<ContactCode | null> {
  const offer = CONTACT_CODE_OFFERS[kind];
  const address = normalizeEmail(email);
  if (!address) return null;
  try {
    const live = await findLiveContactCode(kind, address);
    if (live) return live;

    const percent = boundedPercent(options.percent, offer.percent);
    const endsAt = new Date(Date.now() + offer.ttlHours * HOUR_MS).toISOString();
    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt += 1) {
      const code = generateContactCode(offer.prefix);
      const { error } = await supabaseAdmin.from("coupons").insert({
        code,
        discount_type: "percent",
        discount_value: percent,
        ends_at: endsAt,
        max_redemptions: 1,
        redemptions_count: 0,
        active: true,
        assigned_email: address,
        source: offer.source,
        created_at: new Date().toISOString(),
        is_private: true,
      });
      if (!error) return { code, endsAt, percent };
      // 23505 is the unique index on coupons.code: another draw, not a failure.
      if ((error as { code?: string }).code === "23505") continue;
      console.error("[omnisend/codes] mint refused", { kind, message: error.message });
      return null;
    }
    console.error("[omnisend/codes] mint gave up after repeated code collisions", { kind, attempts: MINT_ATTEMPTS });
    return null;
  } catch (error) {
    console.error("[omnisend/codes] ensureContactCode failed", { kind, error });
    return null;
  }
}

/**
 * Retire every live code of this kind the address holds: `active = false`
 * on the unredeemed rows, so findLiveContactCode stops returning them and
 * the next contact push carries "" for the property. A first order ends the
 * welcome code (order-hooks.ts onOrderPaid) whether or not it was used.
 *
 * Never a delete — the row is the record of what was offered — and never a
 * redeemed row, whose count is the record of the order it priced. Returns
 * how many rows were retired; 0 on any failure, and never throws.
 */
export async function retireContactCode(kind: ContactCodeKind, email: string): Promise<number> {
  const offer = CONTACT_CODE_OFFERS[kind];
  const address = normalizeEmail(email);
  if (!address) return 0;
  try {
    const { data, error } = await supabaseAdmin
      .from("coupons")
      .update({ active: false })
      .eq("assigned_email", address)
      .eq("source", offer.source)
      .eq("active", true)
      .eq("redemptions_count", 0)
      .select("id");
    if (error) {
      console.error("[omnisend/codes] retire refused", { kind, message: error.message });
      return 0;
    }
    return Array.isArray(data) ? data.length : 0;
  } catch (error) {
    console.error("[omnisend/codes] retireContactCode failed", { kind, error });
    return 0;
  }
}
