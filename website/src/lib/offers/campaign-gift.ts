import type { GiftConfig, OfferReward } from "@/lib/offers/gift-terms";

export type { GiftConfig };

// No `server-only` here, deliberately: the campaign composer is a Client
// Component and must be able to validate a gift and show its terms WHILE the
// operator is building it. A verdict that only arrives after Send is a verdict
// that arrives too late — the same reasoning deliverability-check.ts states.
// This module is pure: no I/O, no secrets, no database.

/**
 * A GIFT AN OPERATOR BUILDS FOR ONE CAMPAIGN.
 *
 * WHY THIS EXISTS AT ALL. Automations have carried a gift since the win-back
 * ladder was built — `email_automations.offer_key` picks one entry out of
 * OFFER_CATALOG and the sweep mints it per recipient. Campaigns never got the
 * column. All a broadcast could carry was `promo_code`: a plain shared coupon
 * string, typed into the copy, with no per-recipient binding, no expiry of its
 * own, no one-per-customer rule, and nothing stopping it being pasted into a
 * forum. So the one thing a broadcast to a subscriber list most wants to do —
 * give that list something — was the thing it could not do safely.
 *
 * TWO WAYS TO CHOOSE ONE, and they exist for different jobs:
 *
 *   A CATALOGUE PRESET (`offerKey`). The eleven gifts the store already knows
 *   how to grant, each with a minimum and an expiry that were argued about
 *   once and written down. Picking one of these is the safe default and needs
 *   no judgement from the person sending the campaign.
 *
 *   A CUSTOM GIFT (`custom`). Everything else: a percentage nobody has used
 *   before, a different free product, two of something, a shorter deadline for
 *   a weekend promotion. The operator states the terms and this module refuses
 *   the combinations that would give the store away.
 *
 * WHAT MAKES A CUSTOM GIFT SAFE TO OFFER AT ALL. The redemption path never
 * consults this file, or OFFER_CATALOG, or the campaign row. `customer_offers`
 * records what was promised as COLUMNS — reward_kind, product_slug,
 * percent_off, quantity, min_subtotal_cents, expires_at — and quoteOrder prices
 * from that row. A catalogue key was only ever a template for those columns.
 * That is why a custom gift is not a special case at the till: by the time a
 * customer spends it, it is the same kind of row as every other offer, with the
 * same advisory lock, the same email binding and the same one-per-customer
 * index.
 */
export type CampaignGiftSpec = {
  /** What the operator called it. Shown in the admin and used in the terms line. */
  label: string;
  rewardKind: OfferReward["kind"];
  /** For the product-granting kinds. Validated against the live catalogue server-side. */
  productSlug?: string;
  /** Units of the free product. */
  quantity?: number;
  /** For the percentage-carrying kinds. */
  percent?: number;
  /** The order minimum that unlocks it, in cents. */
  minSubtotalCents: number;
  /** How long a recipient has to spend it. */
  ttlDays: number;
};

export const GIFT_REWARD_KINDS: Array<{ value: OfferReward["kind"]; label: string; needsProduct: boolean; needsPercent: boolean }> = [
  { value: "free_product", label: "A free product", needsProduct: true, needsPercent: false },
  { value: "percent", label: "A percentage off", needsProduct: false, needsPercent: true },
  { value: "free_shipping", label: "Free shipping", needsProduct: false, needsPercent: false },
  { value: "free_shipping_percent", label: "Free shipping + a percentage off", needsProduct: false, needsPercent: true },
  { value: "free_product_percent", label: "A free product + a percentage off", needsProduct: true, needsPercent: true },
];

/** Ceilings. Stated here so they can be argued about in one place. */
export const GIFT_MAX_PERCENT = 100;
export const GIFT_MAX_QUANTITY = 10;
export const GIFT_MAX_TTL_DAYS = 90;
export const GIFT_MAX_MIN_SUBTOTAL_CENTS = 100_000;

/**
 * The minimum a PRODUCT gift must carry, and the reason is not arbitrary.
 *
 * OFFER_CATALOG states it for the free GHK-Cu: "with no minimum, the correct
 * play for a recipient is to redeem the token with nothing else in the basket:
 * the store ships a vial, collects the postage, and books the COGS as a loss."
 * That is true of every free-product gift, not just that one, so it is enforced
 * rather than left to whoever fills the form at 1am. A percentage gift needs no
 * floor — a percentage of nothing is nothing.
 */
export const GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS = 1_000;

export type GiftValidation =
  | { ok: true; config: GiftConfig }
  | { ok: false; error: string };

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
}

/**
 * Turn what an operator typed into a gift the store will actually honour, or
 * say why not.
 *
 * EVERY REFUSAL NAMES THE FIX, because a validation message the person cannot
 * act on is an obstacle they learn to route around. And every refusal is a
 * refusal rather than a silent correction: quietly clamping a 150% discount to
 * 100 would send an email promising something nobody chose.
 *
 * `knownProductSlugs` is passed in rather than read, so this stays pure and so
 * the composer can validate against the catalogue it has already loaded. Pass
 * null to skip the product check — the campaign API does not, and the sender
 * checks again at mint time, because a product can be retired between the
 * moment a campaign is saved and the moment it sends.
 */
export function validateCampaignGift(
  spec: unknown,
  knownProductSlugs: ReadonlySet<string> | null,
): GiftValidation {
  if (!spec || typeof spec !== "object") return { ok: false, error: "No gift was described." };
  const input = spec as Record<string, unknown>;

  const kind = String(input.rewardKind ?? "") as OfferReward["kind"];
  const shape = GIFT_REWARD_KINDS.find((entry) => entry.value === kind);
  if (!shape) return { ok: false, error: "Choose what the gift gives: a product, a percentage, free shipping, or a combination." };

  const label = String(input.label ?? "").trim();
  if (!label) return { ok: false, error: "Give the gift a name, so it can be recognised in reports and in the email." };
  if (label.length > 60) return { ok: false, error: "The gift name is too long. Keep it under 60 characters." };

  const ttlDays = integer(input.ttlDays);
  if (ttlDays === null || ttlDays < 1 || ttlDays > GIFT_MAX_TTL_DAYS) {
    return { ok: false, error: `How long the gift lasts must be a whole number of days between 1 and ${GIFT_MAX_TTL_DAYS}.` };
  }

  const minSubtotalCents = integer(input.minSubtotalCents);
  if (minSubtotalCents === null || minSubtotalCents < 0 || minSubtotalCents > GIFT_MAX_MIN_SUBTOTAL_CENTS) {
    return { ok: false, error: `The order minimum must be between $0 and $${GIFT_MAX_MIN_SUBTOTAL_CENTS / 100}.` };
  }

  let percent: number | undefined;
  if (shape.needsPercent) {
    percent = integer(input.percent) ?? Number.NaN;
    if (!Number.isFinite(percent) || percent < 1 || percent > GIFT_MAX_PERCENT) {
      return { ok: false, error: `The discount must be a whole number between 1% and ${GIFT_MAX_PERCENT}%.` };
    }
  }

  let productSlug: string | undefined;
  let quantity: number | undefined;
  if (shape.needsProduct) {
    productSlug = String(input.productSlug ?? "").trim();
    if (!productSlug) return { ok: false, error: "Choose which product the gift adds to the order." };
    // THE SLUG MUST BE ONE THE DATABASE USES. quoteOrder resolves the product
    // half with an exact match and no fallback, so a wrong slug does not throw
    // and does not degrade visibly: the gift line is simply never added, the
    // percentage half still applies, and the customer gets the discount the
    // email promised and none of the product it promised. That exact failure
    // already shipped once, when a rename left the catalogue naming
    // `bacteriostatic-water`.
    if (knownProductSlugs && !knownProductSlugs.has(productSlug)) {
      return { ok: false, error: `No product with the slug "${productSlug}" is on sale, so the gift would arrive with the discount and without the product.` };
    }
    quantity = integer(input.quantity ?? 1) ?? Number.NaN;
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > GIFT_MAX_QUANTITY) {
      return { ok: false, error: `The number of free units must be between 1 and ${GIFT_MAX_QUANTITY}.` };
    }
    if (minSubtotalCents < GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS) {
      return {
        ok: false,
        error: `A gift that ships a product needs an order minimum of at least $${GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS / 100}. `
          + "Without one, the cheapest way to redeem it is an order containing nothing else, and the store pays the product and the postage.",
      };
    }
  }

  const reward = ((): OfferReward => {
    switch (kind) {
      case "free_product":
        return { kind, productSlug: productSlug!, quantity };
      case "free_product_percent":
        return { kind, productSlug: productSlug!, percent: percent!, quantity };
      case "free_shipping_percent":
        return { kind, percent: percent! };
      case "percent":
        return { kind, percent: percent! };
      default:
        return { kind: "free_shipping" };
    }
  })();

  return { ok: true, config: { label, reward, minSubtotalCents, ttlDays } };
}

/**
 * The offer_key a custom campaign gift is filed under.
 *
 * `customer_offers` has a partial unique index giving one live offer per
 * (offer_key, email), and that invariant is exactly what a campaign wants:
 * one spendable gift per recipient per campaign, and a second campaign to the
 * same person is a genuinely separate gift rather than a collision.
 *
 * Namespaced with `campaign:` so it can never equal an OFFER_CATALOG key —
 * every consumer outside customer-offers.ts already treats offer_key as an
 * opaque string (quoteOrder types it `string`, marketing-source reads it as
 * text), so a key that is not in the catalogue costs nothing downstream.
 */
export function campaignOfferKey(campaignId: string): string {
  return `campaign:${String(campaignId ?? "").trim()}`;
}

/** Is this an offer_key minted by a campaign gift? */
export function isCampaignOfferKey(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("campaign:");
}
