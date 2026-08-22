import { supabaseAdmin } from "@/lib/supabase-server";
import { getHomepageControlConfig, getShippingConfig, getWelcomeOffer } from "@/lib/admin-control";

// ---------------------------------------------------------------------------
// WHAT THE STOREFRONT IS ALLOWED TO ADVERTISE.
//
// THIS FILE CONTAINS NO PROMOTION LOGIC. It decides nothing about who gets a
// discount, how much, or when. It is a READ-ONLY VIEW over the promotion
// systems that already exist, and its entire job is to answer one question:
// "of the offers this store is already honouring, which ones may be shown to a
// stranger, and in what words?"
//
// That distinction is the whole design. A second promotion engine — a table of
// marketing copy with its own dates and its own idea of what is active — is
// how a storefront ends up advertising 20% off while checkout applies 15%.
// Every field below is read from the system that actually enforces it:
//
//   COUPON CODES     public.coupons            -> validateCoupon()   (coupons.ts)
//   WELCOME OFFER    control: welcome_offer     -> validateCoupon()   (coupons.ts)
//   BUY 3 GET 1      control: promotions.*      -> quote-order.ts:501
//   FREE SHIPPING    control: shipping.*        -> calculateShipping()
//   BUNDLE & SAVE    control: bundleConfig      -> bundle-pricing.ts
//
// If a promotion is not in that list, this file does not advertise it. See
// NOT ADVERTISED, at the bottom, for the ones that are deliberately excluded
// and why.
// ---------------------------------------------------------------------------

// The types and every customer-facing string live in storefront-offer-format,
// which is pure and therefore safe for the client bar to import too. This file
// is the SERVER half: it reads the promotion systems and nothing else.
import {
  ONE_DISCOUNT_NOTE,
  discountHeadline,
  offerId,
  type StorefrontOffer,
} from "@/lib/storefront-offer-format";

// Re-exported so existing importers of this module keep working unchanged.
export * from "@/lib/storefront-offer-format";

// ---------------------------------------------------------------------------
// RESOLUTION
// ---------------------------------------------------------------------------

type CouponRow = {
  code: string;
  discount_type: string;
  discount_value: number | string | null;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  redemptions_count: number | null;
  is_private?: boolean | null;
  member_scope?: string | null;
  /** Optional (coupon-storefront-fields.sql). Absent on most installs. */
  storefront_headline?: string | null;
  storefront_priority?: number | null;
};

/**
 * Every publicly advertisable coupon, newest first.
 *
 * The filters mirror validateCoupon() condition for condition, because a code
 * on the bar that checkout rejects is worse than no bar. In particular:
 *
 *   member_scope IS CHECKED HERE, AND IT WAS NOT BEING CHECKED BEFORE.
 *   getStorefrontCoupon() (still used by the product-page banner) selects on
 *   active/assigned_email/dates/is_private but never reads member_scope, so a
 *   coupon scoped to members was advertised to every visitor and then refused
 *   at checkout with "This coupon is exclusive to active members." Only
 *   member_scope 'all' is advertised to an anonymous storefront, because that
 *   is the only scope everyone reading the bar can actually use.
 */
async function publicCoupons(nowIso: string): Promise<CouponRow[]> {
  // Ordered widest-first. storefront_* are optional conveniences
  // (coupon-storefront-fields.sql), is_private/member_scope are older but still
  // newer than the base table. Each step down drops only what is missing, so an
  // install that has run none of the migrations still gets a working bar —
  // and one that has run them all gets the extras with no code change.
  const tiers = [
    "code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, is_private, member_scope, storefront_headline, storefront_priority",
    "code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, is_private, member_scope",
    "code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count",
  ];

  let data: CouponRow[] | null = null;
  let error: unknown = null;
  for (const columns of tiers) {
    const result = await supabaseAdmin
      .from("coupons")
      .select(columns)
      .eq("active", true)
      // Excluded IN SQL rather than in JS: a code minted for one shopper
      // (cart-recovery SAVE-… codes) must not reach the browser even as data.
      .is("assigned_email", null)
      .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
      .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!result.error) {
      data = result.data as unknown as CouponRow[];
      error = null;
      break;
    }
    error = result.error;
  }
  if (error) throw error;

  return ((data ?? []) as CouponRow[]).filter((row) => {
    if (row.is_private) return false;
    // Anything other than 'all' cannot be honoured for an arbitrary reader.
    const scope = String(row.member_scope ?? "all");
    if (scope !== "all") return false;
    if (typeof row.max_redemptions === "number"
      && Number(row.redemptions_count ?? 0) >= row.max_redemptions) return false;
    const value = Number(row.discount_value ?? 0);
    if (!Number.isFinite(value) || value <= 0) return false;
    return true;
  });
}

function couponOffer(row: CouponRow): StorefrontOffer {
  const type = row.discount_type === "fixed" ? "fixed" : "percent";
  const value = Number(row.discount_value ?? 0);
  const code = String(row.code).toUpperCase();
  const details = [ONE_DISCOUNT_NOTE];
  if (typeof row.max_redemptions === "number") {
    const left = row.max_redemptions - Number(row.redemptions_count ?? 0);
    // Only stated when it is genuinely scarce. A "997 remaining" line is
    // manufactured urgency wearing a fact's clothing.
    if (left > 0 && left <= 25) {
      details.push(`Limited to ${row.max_redemptions} order${row.max_redemptions === 1 ? "" : "s"} — ${left} remaining.`);
    }
  }
  // An operator-written headline is phrasing, never arithmetic: the generated
  // one is derived from the coupon's own discount and therefore cannot drift
  // from it, so it is the default and the override has to be typed on purpose.
  const custom = typeof row.storefront_headline === "string" ? row.storefront_headline.trim() : "";
  const headline = custom || `${discountHeadline(type, value)} sitewide`;
  const priority = typeof row.storefront_priority === "number" && Number.isFinite(row.storefront_priority)
    ? row.storefront_priority
    : 10;

  return {
    // The custom headline is part of the identity: editing the wording of a
    // live offer makes it a new offer, so somebody who dismissed the old
    // phrasing sees the new one.
    id: offerId(["coupon", code, type, value, row.ends_at, custom]),
    kind: "coupon",
    eyebrow: "Limited-time offer",
    headline,
    code,
    automaticNote: null,
    endsAt: row.ends_at,
    details,
    href: "/products",
    priority,
    standing: false,
  };
}

export interface ResolveOffersDeps {
  now?: Date;
}

/**
 * The complete, ordered set of offers the storefront may show right now.
 *
 * Throwing is not an option: this runs in the root layout, and a promotion
 * lookup must never be able to take the store down. Each source is guarded
 * individually so one bad read costs one offer, not the bar.
 */
export async function resolveStorefrontOffers(deps: ResolveOffersDeps = {}): Promise<StorefrontOffer[]> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const offers: StorefrontOffer[] = [];

  const [couponRows, welcome, control, shipping] = await Promise.all([
    publicCoupons(nowIso).catch(() => [] as CouponRow[]),
    getWelcomeOffer().catch(() => null),
    getHomepageControlConfig().catch(() => null),
    getShippingConfig().catch(() => null),
  ]);

  for (const row of couponRows) offers.push(couponOffer(row));

  // WELCOME OFFER — a real code enforced by validateCoupon(), but first-order
  // only. The headline says "first order" because the enforcement does, and a
  // returning customer who reads "15% off" and is refused at checkout has been
  // misled by us, not by their own optimism.
  if (welcome?.enabled && welcome.percent > 0 && welcome.code) {
    const code = welcome.code.toUpperCase();
    offers.push({
      id: offerId(["welcome", code, welcome.percent]),
      kind: "welcome",
      eyebrow: "First order",
      headline: `${discountHeadline("percent", welcome.percent)} your first order`,
      code,
      automaticNote: null,
      endsAt: null,
      details: [
        "Valid on a first order only. Once an order has been paid on your email address, the code stops working.",
        ONE_DISCOUNT_NOTE,
      ],
      href: "/products",
      priority: 20,
      standing: false,
    });
  }

  // BUY 3 GET 1 — quote-order.ts:213 makes every 4th unit free, cheapest
  // first, across the whole cart. Both halves of that matter to a customer
  // deciding what to add, so both are stated.
  if (control?.promoBuy3Get1Enabled) {
    offers.push({
      id: offerId(["buy3get1"]),
      kind: "buy3get1",
      eyebrow: "Automatic offer",
      headline: "Buy 3, get 1 free",
      code: null,
      automaticNote: "Applied automatically at checkout",
      endsAt: null,
      details: [
        "Every 4th item in your cart is free. The free item is the lowest-priced one, and it counts across your whole order rather than per product.",
        ONE_DISCOUNT_NOTE,
      ],
      href: "/products",
      priority: 30,
      standing: false,
    });
  }

  // STANDING TERMS — real, honoured, and never the reason the bar appears.
  if (shipping && shipping.freeShippingThreshold > 0) {
    offers.push({
      id: offerId(["free_shipping", shipping.freeShippingThreshold]),
      kind: "free_shipping",
      eyebrow: "Always included",
      headline: `Complimentary shipping over $${shipping.freeShippingThreshold}`,
      code: null,
      automaticNote: "Applied automatically at checkout",
      endsAt: null,
      details: [
        `United States: free over $${shipping.freeShippingThreshold}, otherwise $${shipping.domesticFee}.`,
        `Canada: free over $${shipping.northAmericaFreeShippingThreshold}, otherwise $${shipping.northAmericaFee}.`,
        "Calculated on the order subtotal before tax.",
      ],
      href: null,
      priority: 80,
      standing: true,
    });
  }

  if (control?.bundleConfig) {
    const best = Math.max(
      control.bundleConfig.twoUnitPercent ?? 0,
      control.bundleConfig.threePlusPercent ?? 0,
      control.bundleConfig.fiveUnitPercent ?? 0,
      control.bundleConfig.tenUnitPercent ?? 0,
    );
    if (best > 0) {
      offers.push({
        id: offerId(["bundle", best]),
        kind: "bundle",
        eyebrow: "Always included",
        headline: `Save up to ${Math.round(best * 100)}% on multiples`,
        code: null,
        automaticNote: "Applied automatically at checkout",
        endsAt: null,
        details: [
          "Quantity pricing on a single product, applied as you add units.",
          ONE_DISCOUNT_NOTE,
        ],
        href: "/products",
        priority: 90,
        standing: true,
      });
    }
  }

  // Drop anything whose end date passed between the query and here, then order.
  return offers
    .filter((o) => !o.endsAt || new Date(o.endsAt).getTime() > now.getTime())
    .sort((a, b) => a.priority - b.priority || a.headline.localeCompare(b.headline));
}

/**
 * The layout's entry point. DELIBERATELY NOT CACHED.
 *
 * THIS WAS TRIED WITH `unstable_cache(..., { revalidate: 30 })` AND IT WAS
 * WRONG, in two ways that were only visible from a browser:
 *
 *   1. Next's data cache is stale-while-revalidate. Measured against a live
 *      build: a coupon switched off in the database went on being advertised
 *      for over sixty seconds and across three separate page loads, because
 *      each request was served the stale entry while a refresh happened
 *      behind it. The requirement here is not "eventually correct" — the
 *      moment a code stops working at checkout it must stop being on screen,
 *      or the store is handing out codes it will refuse.
 *
 *   2. Worse, a cached read let `/products` and `/cart` stay STATICALLY
 *      PRERENDERED, which froze the bar at build time. A sale started after
 *      deploy would never have appeared on the catalogue at all.
 *
 * So it resolves per request. The cost is that the shells of a handful of
 * routes render on demand instead of being served prebuilt — the homepage
 * already did, and the catalogue fetches its products client-side regardless,
 * so what is actually given up is small. Advertising a discount the checkout
 * will not honour is not.
 */
export async function getStorefrontOffers(): Promise<StorefrontOffer[]> {
  return resolveStorefrontOffers();
}

// ---------------------------------------------------------------------------
// NOT ADVERTISED, DELIBERATELY.
//
//   AMBASSADOR / REFERRAL CODES  live in `ambassadors`, are attributed to a
//     person and pay a commission. Publishing one would hand every visitor a
//     stranger's commission and destroy the attribution the programme runs on.
//
//   ASSIGNED COUPONS (assigned_email) are one shopper's — cart-recovery SAVE-…
//     codes are minted this way. Excluded in SQL, not in JS, so they cannot
//     reach the browser even as data.
//
//   PRIVATE COUPONS (is_private) are the operator saying "honour this, do not
//     advertise it". That switch already exists in Admin as "Private code —
//     don't advertise on the store".
//
//   MEMBER-SCOPED COUPONS are honoured only for the matching audience, so they
//     are not advertised to an anonymous reader who may be the wrong one.
//
//   BUY 2 GET 1 (50% OFF) — `promotions.buy_2_get_1_half_enabled` is written by
//     the Control Center and read back into HomepageControlConfig, and then
//     NOTHING CONSUMES IT. There is no such branch in quote-order.ts, in the
//     cart, or anywhere in pricing: ticking that box changes no total. It is
//     therefore an admin control that does nothing, and advertising it would
//     promise a discount checkout does not give. Reported, not silently
//     wired up — making a live pricing rule out of a dormant flag is a
//     pricing change, and that is the owner's call, not this feature's.
//
//   MEMBERSHIP PRICING is a product, not a promotion, and has its own page.
// ---------------------------------------------------------------------------
