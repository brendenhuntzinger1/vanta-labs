// ---------------------------------------------------------------------------
// WHAT A PRODUCT PAGE TELLS GOOGLE ABOUT PRICE, STOCK, SHIPPING AND RETURNS.
//
// The Product node itself was already valid — Google reads it and prints the
// price under the result. This module exists for the four things it did NOT
// say, each of which is a visible row in a merchant listing:
//
//   * A PRICE RANGE. Products carry doses, and the schema quoted exactly one:
//     the default. BPC-157 sells at $39.99 (5mg) and $49.99 (10mg), and the
//     structured data claimed a flat $39.99. That is not a missing enhancement,
//     it is the page disagreeing with itself, and a merchant listing whose
//     price does not match the landing page is the specific mismatch Google
//     penalises. Every enabled dose now emits its own Offer with its own price
//     AND its own availability, so a sold-out 10mg no longer inherits the
//     5mg's "in stock".
//
//   * RETURNS. Facts come from the published Return & Reimbursement Policy
//     (legal-content.ts, POLICY: refund) — 14 days from delivery, by mail,
//     customer pays return shipping. Nothing here is a value this module
//     invented; if the policy changes, RETURN_WINDOW_DAYS changes with it and
//     the test below fails until they agree again.
//
//   * SHIPPING. Read from the LIVE admin config, never the coded defaults, for
//     the same reason quote-order.ts does: an admin edits these in Control
//     Center and structured data quoting a stale constant would advertise a
//     price checkout does not charge.
//
//   * BREADCRUMBS. Cosmetic but cheap: search results show "Home › Products ›
//     BPC-157" instead of a bare URL.
//
// DELIBERATELY ABSENT: aggregateRating and review. There is no reviews system
// in this codebase, so there is no honest number to put there. Star ratings are
// the single biggest visual win available on a merchant listing and inventing
// them is review fraud — this comment exists so the omission reads as a
// decision rather than an oversight.
// ---------------------------------------------------------------------------

import { breadcrumbList as crumbsToSchema } from "@/lib/breadcrumbs";
import type { Product, ProductDose } from "@/lib/catalog-types";
import type { ShippingConfig } from "@/lib/shipping";

/**
 * Days from delivery within which a return must be REQUESTED. Mirrors the
 * "within 14 days of delivery" bullet in the published refund policy.
 */
export const RETURN_WINDOW_DAYS = 14;

/**
 * Only the US and Canada are shippable today — every other country is rejected
 * at checkout (see shipping.ts). Claiming a shipping rate or a return route for
 * a country the checkout refuses would be a promise the site cannot keep.
 */
export const SHIPPABLE_COUNTRIES = ["US", "CA"] as const;

type StockStatus = Product["stockStatus"];

/** "$39.99" -> 39.99. Undefined for anything without a usable number. */
export function priceToNumber(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * What a shopper actually pays for a dose: the sale price when one is set,
 * otherwise the list price. Quoting `price` while the page charges `salePrice`
 * is the same landing-page mismatch the dose split above fixes.
 */
export function effectiveDosePrice(dose: ProductDose): number | undefined {
  return priceToNumber(dose.salePrice) ?? priceToNumber(dose.price);
}

/**
 * Only an explicit "In Stock" becomes InStock. Anything else — Limited,
 * Reserved, Out of Stock, or an unrecognised value — maps to something that
 * does not over-claim, because over-claiming availability is what gets a
 * merchant listing demoted.
 */
export function availabilityUrl(status?: StockStatus): string {
  if (status === "In Stock") return "https://schema.org/InStock";
  if (status === "Out of Stock") return "https://schema.org/OutOfStock";
  return "https://schema.org/LimitedAvailability";
}

/** The published return policy, as Google reads it. */
export function merchantReturnPolicy() {
  return {
    "@type": "MerchantReturnPolicy",
    applicableCountry: [...SHIPPABLE_COUNTRIES],
    returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
    merchantReturnDays: RETURN_WINDOW_DAYS,
    returnMethod: "https://schema.org/ReturnByMail",
    // The policy states plainly: "Customers are responsible for return shipping
    // on ordinary returns."
    returnFees: "https://schema.org/ReturnShippingFees",
  };
}

/**
 * Shipping, expressed as the RANGE it actually is.
 *
 * Domestic shipping is free over a threshold and a flat fee under it. A single
 * `value` cannot say that: quoting the flat fee overstates it for a large
 * order, and quoting zero understates it for a small one — and understating is
 * the direction Google treats as a violation. A MonetaryAmount with minValue 0
 * and maxValue <flat fee> is the honest statement of both ends.
 */
export function shippingDetails(config: ShippingConfig) {
  const zones: Array<{ country: (typeof SHIPPABLE_COUNTRIES)[number]; fee: number }> = [
    { country: "US", fee: config.domesticFee },
    { country: "CA", fee: config.northAmericaFee },
  ];

  return zones
    .filter((zone) => Number.isFinite(zone.fee) && zone.fee >= 0)
    .map((zone) => ({
      "@type": "OfferShippingDetails",
      shippingRate: {
        "@type": "MonetaryAmount",
        minValue: 0,
        maxValue: zone.fee,
        currency: "USD",
      },
      shippingDestination: {
        "@type": "DefinedRegion",
        addressCountry: zone.country,
      },
    }));
}

/**
 * Doses a shopper can actually buy, priced. A disabled dose is not purchasable,
 * so offering it would advertise something checkout will not sell.
 */
export function sellableDoses(product: Product): ProductDose[] {
  return (product.doses ?? []).filter((dose) => dose.isEnabled && effectiveDosePrice(dose) !== undefined);
}

/**
 * One Offer per purchasable dose, or a single Offer for a product without
 * distinct dose pricing. Returns undefined when there is no usable price at
 * all, so the caller omits `offers` rather than emitting an empty one.
 */
export function buildOffers({
  product,
  url,
  shipping,
}: {
  product: Product;
  url: string;
  shipping: ShippingConfig;
}) {
  const common = {
    "@type": "Offer" as const,
    priceCurrency: "USD",
    url,
    shippingDetails: shippingDetails(shipping),
    hasMerchantReturnPolicy: merchantReturnPolicy(),
  };

  const doses = sellableDoses(product);

  // A single dose carries no more information than the product-level price, so
  // it collapses to one Offer rather than an array of one.
  if (doses.length > 1) {
    return doses.map((dose) => ({
      ...common,
      price: effectiveDosePrice(dose),
      availability: availabilityUrl(dose.stockStatus ?? product.stockStatus),
      // Only a real SKU. There is no value in minting one from the slug and
      // then having it disagree with the warehouse.
      ...(dose.sku ? { sku: dose.sku } : {}),
      name: dose.label,
    }));
  }

  const single = doses[0];
  const price = single ? effectiveDosePrice(single) : priceToNumber(product.salePrice) ?? priceToNumber(product.price);
  if (price === undefined) return undefined;

  return {
    ...common,
    price,
    availability: availabilityUrl(single?.stockStatus ?? product.stockStatus),
    ...(single?.sku ? { sku: single.sku } : {}),
  };
}

/** Home › Products › <product>, using real crawlable URLs at every level. */
export function breadcrumbList({ product, siteUrl }: { product: Product; siteUrl: string }) {
  return crumbsToSchema([
    { name: "Home", url: `${siteUrl}/` },
    { name: "Products", url: `${siteUrl}/products` },
    { name: product.name, url: `${siteUrl}/products/${product.slug}` },
  ]);
}
