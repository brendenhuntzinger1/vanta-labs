import { formatDisplayDate } from "@/lib/format-date";

// ---------------------------------------------------------------------------
// THE SHAPE OF AN OFFER, AND THE WORDS USED TO DESCRIBE ONE.
//
// SPLIT OUT OF storefront-offers.ts SO THE BAR CAN IMPORT IT.
// The resolver reaches Supabase and the admin control tables, which pull in
// "server-only" — importing it from a client component takes the whole server
// module graph with it and the build refuses, correctly. Everything here is
// pure: types, string formatting, and one constant. No I/O, so both sides can
// share it and the wording in the browser is the wording the server resolved.
// ---------------------------------------------------------------------------

export type OfferKind = "coupon" | "welcome" | "buy3get1" | "free_shipping" | "bundle";

/**
 * A seasonal treatment for the bar. Absent on almost every offer, almost always.
 *
 * PAINT AND AN EYEBROW, NEVER A PRICE. A theme is stamped onto an offer AFTER
 * it has been resolved from the system that enforces it (see
 * labor-day-campaign.ts), and it may not alter the headline, the code, the end
 * date or the terms — so a themed bar advertises exactly what an unthemed one
 * would have, in different clothes.
 */
export type OfferTheme = "americana";

export interface StorefrontOffer {
  /**
   * Stable identity, and deliberately CONTENT-DERIVED rather than a row id.
   *
   * Dismissal is keyed on this. If it were the coupon's uuid, editing a live
   * coupon from 10% to 25% would leave it dismissed for everyone who had waved
   * away the smaller offer. Deriving it from the terms means changing the
   * terms produces a new offer, which is eligible to appear again — which is
   * the behaviour asked for, and it falls out of the id instead of needing a
   * version counter somebody has to remember to bump.
   */
  id: string;
  kind: OfferKind;
  /** Small line above the headline. Never the main message. */
  eyebrow: string;
  /** The benefit, and the first thing the eye should land on. */
  headline: string;
  /** Present only when a code must be typed. null => applied automatically. */
  code: string | null;
  /** Present only when there is NO code. Mutually exclusive with `code`. */
  automaticNote: string | null;
  /** Real timestamp from the promotion record, or null. Never invented. */
  endsAt: string | null;
  /** Conditions. Shown behind DETAILS, never in the bar itself. */
  details: string[];
  /** Where "shop the offer" goes, when going anywhere makes sense. */
  href: string | null;
  /** Lower sorts first. Set from the promotion's own nature, not randomly. */
  priority: number;
  /**
   * A STANDING TERM OF SALE rather than a promotion.
   *
   * Free shipping over $200 and quantity pricing are always on. If they could
   * raise the bar on their own, the "current offers" bar would be permanent
   * furniture that says nothing new — and the first real sale would land in a
   * space customers had already learned to ignore. They ride along when a real
   * promotion is running, and they are listed in full under VIEW ALL OFFERS,
   * but they never open the bar by themselves.
   */
  standing: boolean;
  /**
   * Seasonal dress, applied on top of a fully resolved offer. Absent = the
   * ordinary bar.
   *
   * Optional rather than required so that every place an offer is BUILT stays
   * free of seasonal concerns — the campaign is stamped on afterwards, in one
   * place, and nothing that reads a promotion has to know a holiday exists.
   */
  theme?: OfferTheme;
}

// ---------------------------------------------------------------------------
// PURE FORMATTING. No I/O, so it can be tested exhaustively.
// ---------------------------------------------------------------------------

/** "$20 OFF" / "$19.50 OFF" / "15% OFF" — never "$20.00 OFF". */
export function discountHeadline(discountType: "percent" | "fixed", discountValue: number): string {
  if (discountType === "fixed") {
    const value = Number.isInteger(discountValue) ? String(discountValue) : discountValue.toFixed(2);
    return `$${value} OFF`;
  }
  return `${Number.isInteger(discountValue) ? discountValue : discountValue.toFixed(1)}% OFF`;
}

/**
 * "Ends today" / "Ends Aug 25" / null.
 *
 * Deliberately coarse. A live countdown is only honest when the promotion ends
 * at a timestamp the server enforces to the second, and coupons here end on a
 * date — so a ticking clock would be precision this data does not have. "Ends
 * tonight" is true on the last day and says nothing that has to be re-derived
 * every second on a phone.
 */
export function endsLabel(endsAt: string | null, now: Date = new Date()): string | null {
  if (!endsAt) return null;
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return null;
  if (end.getTime() <= now.getTime()) return null;

  // "Today" HAS TO BE ASKED IN THE BUSINESS ZONE, not the machine's.
  // getDate() on a Vercel server answers in UTC, so between 8pm and midnight
  // Eastern the server would call tomorrow "today" while the shopper's browser
  // said otherwise — a wrong claim AND a hydration mismatch, which is exactly
  // the pair of bugs format-date.ts was written to end. Comparing the rendered
  // day strings uses that same pinned zone for both sides.
  //
  // COMPARE A STYLE THAT CARRIES THE YEAR. This was "short", which is
  // `{ month: "short", day: "numeric" }` and has no year in it — so 3 September
  // 2027 rendered "Sep 3", 3 September 2026 rendered "Sep 3", they compared
  // equal, and a promotion TWELVE MONTHS AWAY was advertised to every visitor
  // as ending today. "medium" is the same pinned zone plus the year.
  //
  // The word is "today", not "tonight", because an offer expiring at 9am is not
  // ending tonight — and "today" is true for every same-day expiry, morning or
  // evening, without giving up the urgency.
  if (formatDisplayDate(end, "medium") === formatDisplayDate(now, "medium")) return "Ends today";

  const label = formatDisplayDate(endsAt, "short");
  return label ? `Ends ${label}` : null;
}

/** Content-derived so changed terms produce a new, undismissed offer. */
export function offerId(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((p) => (p == null ? "" : String(p)))
    .join(":")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/**
 * A short, stable tag for an offer id, for storing dismissals in a COOKIE.
 *
 * Dismissals have to be readable by the SERVER — that is the only way the bar
 * can be rendered correct on the first paint instead of appearing and then
 * vanishing under the reader. Cookies travel on every request, so what goes in
 * one has to be small: full ids run 40-60 characters each and a handful of them
 * would put a couple of kilobytes on every asset request. This is FNV-1a over
 * the id, base36, so eight dismissals cost about seventy bytes.
 *
 * A collision would hide one offer from one visitor. At eight stored tags out
 * of a 32-bit space that is a one-in-tens-of-millions event, and its cost is a
 * missed banner rather than a wrong price.
 */
export function offerTag(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** How many dismissals to remember. Bounded so the cookie stays small. */
export const MAX_DISMISSALS = 8;

/**
 * Readable by the browser on purpose — the bar writes it when someone taps the
 * ×, and the server reads it on the next request. It carries no identity and no
 * preference beyond "this visitor waved away these offers", so there is nothing
 * in it to protect with httpOnly, and making it httpOnly would mean a round
 * trip to dismiss a banner.
 */
export const OFFERS_DISMISSED_COOKIE = "vl_offers_dismissed";

/** Parse the dismissal cookie defensively — it is user-editable input. */
export function parseDismissed(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(".")
    .filter((tag) => /^[a-z0-9]{1,8}$/.test(tag))
    .slice(-MAX_DISMISSALS);
}

export function serializeDismissed(tags: string[]): string {
  return [...new Set(tags)].slice(-MAX_DISMISSALS).join(".");
}

/**
 * THE SENTENCE THAT KEEPS THE BAR HONEST.
 *
 * resolveBestDiscount() in discount-resolution.ts applies exactly ONE discount
 * per order — the largest — across bulk savings, buy-3-get-1, referral,
 * coupon, member pricing and ambassador codes. So a bar showing a coupon and
 * an automatic promotion side by side is, without this line, an implied promise
 * that they add up. They do not, and finding that out at the total is the kind
 * of surprise that loses the order and earns the chargeback.
 *
 * Shipping is not in that competition — calculateShipping() is computed
 * separately from the discount — so free shipping genuinely does apply on top,
 * and the wording says so rather than over-disclaiming.
 */
export const ONE_DISCOUNT_NOTE =
  "One discount applies per order — Vanta automatically uses whichever saves you the most. Free shipping is separate and still applies.";


/** The bar opens only for a real promotion; standing terms ride along. */
export function hasPromotableOffer(offers: StorefrontOffer[]): boolean {
  return offers.some((o) => !o.standing);
}

/** What the bar is allowed to render: nothing at all, unless a promotion is live. */
export function visibleOffers(offers: StorefrontOffer[]): StorefrontOffer[] {
  return hasPromotableOffer(offers) ? offers : [];
}

