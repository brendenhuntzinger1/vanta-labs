import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RETURN_WINDOW_DAYS,
  SHIPPABLE_COUNTRIES,
  availabilityUrl,
  breadcrumbList,
  buildOffers,
  effectiveDosePrice,
  merchantReturnPolicy,
  priceToNumber,
  sellableDoses,
  shippingDetails,
} from "./product-structured-data";
import { DEFAULT_SHIPPING_CONFIG, type ShippingConfig } from "./shipping";
import type { Product, ProductDose } from "./catalog-types";

const SITE = "https://www.vantalabsresearch.com";

function dose(overrides: Partial<ProductDose> = {}): ProductDose {
  return {
    id: "dose-1",
    label: "5mg",
    slugSuffix: "5mg",
    price: "$39.99",
    isDefault: true,
    isEnabled: true,
    position: 1,
    stockStatus: "In Stock",
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    slug: "bpc-157",
    name: "BPC-157",
    category: "Repair & Recovery Research",
    price: "$39.99",
    stockStatus: "In Stock",
    batchNumber: "",
    description: "A synthetic pentadecapeptide.",
    image: "https://example.test/bpc-157.webp",
    testingDate: "",
    labName: "",
    coaUrl: "",
    ...overrides,
  };
}

describe("price parsing", () => {
  it("reads a formatted price", () => {
    expect(priceToNumber("$39.99")).toBe(39.99);
  });

  it("returns undefined rather than 0 for junk, so `offers` is omitted not zero-priced", () => {
    expect(priceToNumber(undefined)).toBeUndefined();
    expect(priceToNumber("")).toBeUndefined();
    expect(priceToNumber("Call for pricing")).toBeUndefined();
    expect(priceToNumber("$0.00")).toBeUndefined();
  });

  it("quotes the sale price when one is set, because that is what checkout charges", () => {
    expect(effectiveDosePrice(dose({ price: "$49.99", salePrice: "$29.99" }))).toBe(29.99);
    expect(effectiveDosePrice(dose({ price: "$49.99" }))).toBe(49.99);
  });
});

describe("availability never over-claims", () => {
  it("maps only an explicit In Stock to InStock", () => {
    expect(availabilityUrl("In Stock")).toBe("https://schema.org/InStock");
    expect(availabilityUrl("Out of Stock")).toBe("https://schema.org/OutOfStock");
    expect(availabilityUrl("Limited")).toBe("https://schema.org/LimitedAvailability");
    expect(availabilityUrl("Reserved")).toBe("https://schema.org/LimitedAvailability");
    expect(availabilityUrl(undefined)).toBe("https://schema.org/LimitedAvailability");
  });
});

describe("the return policy matches the policy the site publishes", () => {
  // The whole value of hasMerchantReturnPolicy is that it agrees with the page
  // a shopper can read. This fails the moment the two drift apart.
  it("takes its window from the published Return & Reimbursement Policy", () => {
    const source = readFileSync(join(__dirname, "legal-content.ts"), "utf8");
    const match = source.match(/within \*\*(\d+) days of delivery\*\*/);
    expect(match, "refund policy no longer states a return window in days").not.toBeNull();
    expect(Number(match![1])).toBe(RETURN_WINDOW_DAYS);
  });

  it("says the customer pays return shipping, as the policy does", () => {
    const policy = merchantReturnPolicy();
    expect(policy.returnFees).toBe("https://schema.org/ReturnShippingFees");
    expect(policy.returnMethod).toBe("https://schema.org/ReturnByMail");
    expect(policy.merchantReturnDays).toBe(14);
    expect(policy.applicableCountry).toEqual(["US", "CA"]);
  });

  it("only claims countries checkout will actually ship to", () => {
    expect([...SHIPPABLE_COUNTRIES]).toEqual(["US", "CA"]);
  });
});

describe("shipping is quoted as the range it really is", () => {
  it("spans free-over-threshold to the flat fee, rather than picking one end", () => {
    const details = shippingDetails(DEFAULT_SHIPPING_CONFIG);
    const us = details.find((d) => d.shippingDestination.addressCountry === "US");
    expect(us?.shippingRate.minValue).toBe(0);
    expect(us?.shippingRate.maxValue).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
    expect(us?.shippingRate.currency).toBe("USD");
  });

  it("reads the live admin config, not the coded defaults", () => {
    const edited: ShippingConfig = { ...DEFAULT_SHIPPING_CONFIG, domesticFee: 9, northAmericaFee: 19 };
    const details = shippingDetails(edited);
    expect(details.find((d) => d.shippingDestination.addressCountry === "US")?.shippingRate.maxValue).toBe(9);
    expect(details.find((d) => d.shippingDestination.addressCountry === "CA")?.shippingRate.maxValue).toBe(19);
  });
});

describe("offers describe every dose a shopper can buy", () => {
  const shipping = DEFAULT_SHIPPING_CONFIG;
  const url = `${SITE}/products/bpc-157`;

  it("emits one offer per dose when the doses are priced differently", () => {
    // The bug this replaces: the schema quoted $39.99 flat while the page sold
    // a 5mg at $39.99 and a 10mg at $49.99.
    const offers = buildOffers({
      product: product({
        doses: [
          dose({ id: "a", label: "5mg", price: "$39.99" }),
          dose({ id: "b", label: "10mg", price: "$49.99", isDefault: false, position: 2 }),
        ],
      }),
      url,
      shipping,
    });

    expect(Array.isArray(offers)).toBe(true);
    expect((offers as unknown[]).length).toBe(2);
    expect((offers as Array<{ price?: number }>).map((o) => o.price)).toEqual([39.99, 49.99]);
  });

  it("gives each dose its own availability, so a sold-out size cannot inherit In Stock", () => {
    const offers = buildOffers({
      product: product({
        doses: [
          dose({ id: "a", label: "5mg", stockStatus: "In Stock" }),
          dose({ id: "b", label: "10mg", price: "$49.99", stockStatus: "Out of Stock", isDefault: false, position: 2 }),
        ],
      }),
      url,
      shipping,
    }) as Array<{ availability?: string }>;

    expect(offers[0].availability).toBe("https://schema.org/InStock");
    expect(offers[1].availability).toBe("https://schema.org/OutOfStock");
  });

  it("never offers a disabled dose, which checkout will not sell", () => {
    const withDisabled = product({
      doses: [
        dose({ id: "a", label: "5mg" }),
        dose({ id: "b", label: "10mg", price: "$49.99", isEnabled: false, isDefault: false, position: 2 }),
      ],
    });
    expect(sellableDoses(withDisabled)).toHaveLength(1);
    expect(Array.isArray(buildOffers({ product: withDisabled, url, shipping }))).toBe(false);
  });

  it("collapses to a single offer for a one-dose product", () => {
    const offers = buildOffers({ product: product({ doses: [dose()] }), url, shipping }) as { price?: number };
    expect(Array.isArray(offers)).toBe(false);
    expect(offers.price).toBe(39.99);
  });

  it("falls back to the product price when there are no dose rows at all", () => {
    const offers = buildOffers({ product: product({ doses: [] }), url, shipping }) as { price?: number };
    expect(offers.price).toBe(39.99);
  });

  it("omits offers entirely when nothing has a usable price", () => {
    expect(buildOffers({ product: product({ price: "", doses: [] }), url, shipping })).toBeUndefined();
  });

  it("attaches shipping and returns to every offer", () => {
    const offers = buildOffers({
      product: product({
        doses: [dose({ id: "a" }), dose({ id: "b", price: "$49.99", isDefault: false, position: 2 })],
      }),
      url,
      shipping,
    }) as Array<Record<string, unknown>>;

    for (const offer of offers) {
      expect(offer.hasMerchantReturnPolicy).toBeTruthy();
      expect(offer.shippingDetails).toHaveLength(2);
      expect(offer.url).toBe(url);
      expect(offer.priceCurrency).toBe("USD");
    }
  });

  it("omits sku rather than minting one that no warehouse would recognise", () => {
    const withoutSku = buildOffers({ product: product({ doses: [dose()] }), url, shipping }) as Record<string, unknown>;
    expect(withoutSku).not.toHaveProperty("sku");

    const withSku = buildOffers({
      product: product({ doses: [dose({ sku: "VL-BPC-5" })] }),
      url,
      shipping,
    }) as Record<string, unknown>;
    expect(withSku.sku).toBe("VL-BPC-5");
  });
});

describe("breadcrumbs", () => {
  it("walks Home > Products > product with crawlable URLs", () => {
    const crumbs = breadcrumbList({ product: product(), siteUrl: SITE });
    expect(crumbs.itemListElement.map((c) => c.item)).toEqual([
      `${SITE}/`,
      `${SITE}/products`,
      `${SITE}/products/bpc-157`,
    ]);
    expect(crumbs.itemListElement.map((c) => c.position)).toEqual([1, 2, 3]);
    expect(crumbs.itemListElement[2].name).toBe("BPC-157");
  });
});
