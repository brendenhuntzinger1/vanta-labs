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
//   BUY X GET Y      control: promotions.bxgy_promotions
//                                              -> bxgy-engine.ts, via quote-order.ts
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
  discountHeadline,
  offerId,
  type StorefrontOffer,
} from "@/lib/storefront-offer-format";
import { advertisableBxgyPromotions, promotionHeadline, storefrontDescription, type BxgyPromotion } from "@/lib/bxgy-engine";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";

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
/**
 * The column tier that last satisfied the database, for the life of this
 * process. `null` until something has actually worked.
 *
 * WHY THIS EXISTS. The ladder below is migration-tolerant by design, and that
 * part is right. What it lacked was memory: production has never run
 * coupon-storefront-fields.sql, so the widest tier asked for
 * `coupons.storefront_headline` on every single request and Postgres answered
 * `42703 column does not exist` every single time — 2,350 guaranteed-failing
 * requests in 24 hours, one per page load, for a column that cannot appear
 * without a migration.
 *
 * Deliberately per-process rather than persisted: a cold start re-probes, so
 * running the migration is still picked up without a code change, and there is
 * no cache to invalidate. A remembered tier that later fails re-probes the
 * whole ladder immediately (see selectColumnTier), so this is not a one-way
 * door into a narrower tier.
 */
let cachedColumnTier: string | null = null;

/** Test-only: the cache is module state and would leak between cases. */
export function __resetColumnTierCache(): void {
  cachedColumnTier = null;
}

/**
 * Run `attempt` against the first column list the database accepts, preferring
 * whichever one worked last time.
 *
 * Only a SUCCESS is remembered. Caching a tier that merely happened to be tried
 * last during a total outage would pin every subsequent request to it.
 */
export async function selectColumnTier<T>(
  tiers: readonly string[],
  attempt: (columns: string) => Promise<{ ok: true; value: T } | { ok: false; error: unknown }>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const remembered = cachedColumnTier;
  const order = remembered === null
    ? [...tiers]
    : [remembered, ...tiers.filter((tier) => tier !== remembered)];

  let error: unknown = new Error("No column tier was attempted.");
  for (const columns of order) {
    const result = await attempt(columns);
    if (result.ok) {
      cachedColumnTier = columns;
      return result;
    }
    error = result.error;
  }
  return { ok: false, error };
}

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

  const attempted = await selectColumnTier<CouponRow[]>(tiers, async (columns) => {
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

    return result.error
      ? { ok: false, error: result.error }
      : { ok: true, value: result.data as unknown as CouponRow[] };
  });
  if (!attempted.ok) throw attempted.error;
  const data = attempted.value;

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
  const details: string[] = [];
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

  // Guarded on its own, like every other source here: a failed promotion read
  // costs the promotion offers, never the bar.
  //
  // advertisableBxgyPromotions is the LAST step, applied to the list the
  // checkout prices from rather than to the config. That ordering is what
  // makes "hidden" mean unadvertised and nothing else: the promotion is still
  // resolved, still scheduled, still counted against its redemption cap — it
  // simply does not reach the words. Exactly what `is_private` does one
  // function down for a coupon code.
  const promotions: BxgyPromotion[] = await getApplicableBxgyPromotions(
    {},
    { promotions: control?.bxgyPromotions, now },
  ).then(advertisableBxgyPromotions).catch(() => []);

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
      ],
      href: "/products",
      priority: 20,
      standing: false,
    });
  }

  // BUY X GET Y — every live promotion in the promotion centre, described from
  // the promotion record that prices it (bxgy-engine.ts). This is still a
  // READ-ONLY VIEW: nothing here decides that a promotion runs, and a promotion
  // outside its schedule or past its usage limit is already absent from
  // `promotions` because getApplicableBxgyPromotions resolved it away.
  //
  // The old branch read `control.promoBuy3Get1Enabled` and hard-coded "Buy 3,
  // get 1 free". That flag is now the on/off switch for ONE of six promotions
  // and is reconciled onto it in bxgy-config.ts, so reading the promotion list
  // advertises exactly what checkout will honour — including the Buy 2 Get 1
  // (50% off) switch that this file previously, and correctly, refused to
  // advertise on the grounds that nothing consumed it. Something does now.
  for (const promotion of promotions ?? []) {
    offers.push({
      id: offerId(["bxgy", promotion.id, promotion.buyQuantity, promotion.getQuantity, promotion.rewardPercent]),
      kind: "buy3get1",
      eyebrow: "Automatic offer",
      headline: promotionHeadline(promotion),
      code: null,
      automaticNote: "Applied automatically at checkout",
      // A real timestamp from the promotion record, or null. The bar's own
      // rule: never invent an end date.
      endsAt: promotion.endsAt,
      details: [
        storefrontDescription(promotion),
        promotion.eligibility.excludeSlugs.length > 0
          ? "Some products are excluded."
          : "Counts across your whole order rather than per product.",
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
//   BUY X GET Y PROMOTIONS THAT ARE OFF, out of schedule, or past a usage
//     limit are not in `promotions` at all — getApplicableBxgyPromotions has
//     already resolved them away, so the bar cannot advertise one checkout
//     would refuse.
//
//     This paragraph used to report `promotions.buy_2_get_1_half_enabled` as an
//     admin control that changed no total, and refused to advertise it on
//     exactly that ground. It is now the on/off switch for the Buy 2 Get 1
//     (50% Off) promotion in the promotion centre, priced by the same engine as
//     the other five, so it is advertised like any other live promotion.
//
//   MEMBERSHIP PRICING is a product, not a promotion, and has its own page.
// ---------------------------------------------------------------------------
