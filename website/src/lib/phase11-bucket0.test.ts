import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BUNDLE_CONFIG,
  bundleDiscountRate,
  resolveBundleConfig,
} from "@/lib/bundle-pricing";
import {
  DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
  DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
  PROCESSING_FEE_DEFAULT_PERCENT,
  WORST_CASE_UNIT_COST_DEFAULT,
} from "@/lib/admin-control-shared";
import { DEFAULT_PROFIT_SETTINGS, meetsFloor } from "@/lib/profit-engine";
import {
  INTERNATIONAL_FREE_SHIPPING_THRESHOLD,
  INTERNATIONAL_SHIPPING_FEE,
} from "@/lib/shipping";
import { resolveUnitCostCents } from "@/lib/quote-order";

// ---------------------------------------------------------------------------
// Phase 11, bucket 0 — regressions for the P3 findings fixed in this pass.
//
// Several of these are source-level assertions rather than behavioural ones,
// following src/lib/handoff-invariants.test.ts. That is deliberate and it is
// stated per case: a duplicated constant, a placeholder that lies about a
// default, and a comment that contradicts the code are all conditions no unit
// test can observe by calling the function — the two copies AGREE today, which
// is exactly what makes the copy dangerous. What can be asserted is that the
// second copy is gone.
// ---------------------------------------------------------------------------

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const adminClient = source("src/components/admin-control-center-client.tsx");

// ---------------------------------------------------------------------------
// CFG-04 — a Promotions input wired to a key nothing reads.
// ---------------------------------------------------------------------------
describe("CFG-04: the Control Center has one free-shipping threshold, not two", () => {
  it("does not write promotions.free_shipping_threshold", () => {
    // getHomepageControlConfig (admin-control.ts) reads the promotions section
    // and never returns this key, so typing in the Promotions box changed
    // nothing while sitting 13 lines above the box that works.
    expect(adminClient).not.toContain('{ section: "promotions", key: "free_shipping_threshold"');
    expect(adminClient).not.toContain("promoFreeShippingThreshold");
  });

  it("keeps the Shipping section's threshold, which getShippingConfig does read", () => {
    expect(adminClient).toContain('{ section: "shipping", key: "free_shipping_threshold", value: shippingFreeThreshold }');
  });
});

// ---------------------------------------------------------------------------
// CFG-05 — a rate the panel reports as "in force" with no way to set it.
// ---------------------------------------------------------------------------
describe("CFG-05: the customer referral discount is editable, not just displayed", () => {
  it("writes referral.discount_percent, the key getReferralProgramConfig reads", () => {
    expect(adminClient).toContain('{ section: "referral", key: "discount_percent", value: referralDiscount }');
  });

  it("repopulates the input from the stored value, like its two siblings", () => {
    expect(adminClient).toContain("setReferralDiscount(referral.discount_percent != null");
  });

  it("renders an input for it", () => {
    expect(adminClient).toContain("Customer referral discount (% off for shoppers using an ambassador");
  });
});

// ---------------------------------------------------------------------------
// CFG-07 — a third copy of the bundle rates, drifted.
// ---------------------------------------------------------------------------
describe("CFG-07: bundle-pricing has no rate literal that disagrees with the defaults", () => {
  const bundlePricing = source("src/lib/bundle-pricing.ts");

  it("every `DEFAULT_BUNDLE_CONFIG.<tier> ?? <literal>` tail matches the constant", () => {
    // The tails are unreachable while DEFAULT_BUNDLE_CONFIG populates both
    // optional tiers, which is why calling resolveBundleConfig cannot catch
    // this: they had drifted to 0.10 / 0.15 against real defaults of 0.12 /
    // 0.20, and would have silently under-discounted the 5+ and 10+ tiers the
    // day either field left the constant.
    const tails = [...bundlePricing.matchAll(/DEFAULT_BUNDLE_CONFIG\.(\w+) \?\? ([\d.]+)/g)];
    expect(tails.length).toBeGreaterThan(0);
    for (const [, field, literal] of tails) {
      const configured = DEFAULT_BUNDLE_CONFIG[field as keyof typeof DEFAULT_BUNDLE_CONFIG];
      expect(Number(literal), `${field} fallback literal`).toBe(configured);
    }
  });

  it("resolveBundleConfig's blank-field tiers equal what bundleDiscountRate charges", () => {
    const blank = resolveBundleConfig({});
    expect(blank.fiveUnitPercent).toBe(bundleDiscountRate(5));
    expect(blank.tenUnitPercent).toBe(bundleDiscountRate(10));
  });
});

// ---------------------------------------------------------------------------
// CFG-09 / SOT-09 — placeholders stating a default the store does not use.
// ---------------------------------------------------------------------------
describe("CFG-09/SOT-09: shipping placeholders state the real blank-field defaults", () => {
  it("the international placeholders come from shipping.ts", () => {
    expect(INTERNATIONAL_SHIPPING_FEE).toBe(60);
    expect(INTERNATIONAL_FREE_SHIPPING_THRESHOLD).toBe(600);
    expect(adminClient).toContain(`International flat rate ($)<input value={shippingIntlFlatRate} onChange={(e) => setShippingIntlFlatRate(e.target.value)} placeholder="${INTERNATIONAL_SHIPPING_FEE}"`);
    expect(adminClient).toContain(`International free shipping over ($)<input value={shippingIntlFreeThreshold} onChange={(e) => setShippingIntlFreeThreshold(e.target.value)} placeholder="${INTERNATIONAL_FREE_SHIPPING_THRESHOLD}"`);
  });
});

// ---------------------------------------------------------------------------
// CFG-12 / SOT-12 — comments asserting the opposite of the code beside them.
// ---------------------------------------------------------------------------
describe("CFG-12/SOT-12: no comment contradicts the code it sits on", () => {
  it("the cart's shipping-protection comment matches its actual default", () => {
    // Shipping protection is now PRE-SELECTED, so this test asserts the
    // opposite of what it used to — but the rule it enforces is unchanged: the
    // prose beside the declaration must describe the declaration.
    //
    // The old assertion was `expect(cart).toContain("useState(false)")`, which
    // is satisfied by any of the ~10 unrelated booleans in this file that start
    // false, so it kept passing after the default flipped and proved nothing.
    // Anchored to the declaration itself now.
    const cart = source("src/components/cart-context.tsx");
    const declaration = /const \[shippingProtectionEnabled, setShippingProtectionEnabled\] = useState\(([^)]*)\)/
      .exec(cart);
    expect(declaration, "no shippingProtectionEnabled declaration found").toBeTruthy();
    expect(declaration![1].trim()).toBe("true");

    // ...and the comment above it must not still be arguing for opt-in.
    expect(cart).not.toMatch(/OFF BY DEFAULT/);
    expect(cart).toMatch(/PRE-SELECTED BY DEFAULT/);
  });

  it("the wallet breakdown describes the wallet rule, not the cart default", () => {
    // quote-order builds the line items shown INSIDE the Apple/Google Pay
    // sheet. Protection is pre-selected in the cart but deliberately not
    // inherited by that lane, so a comment here claiming either "off by
    // default" (stale) or "defaults on" (true of the cart, false of this file)
    // would misdescribe the code beside it.
    const quote = source("src/lib/quote-order.ts");
    expect(quote).not.toContain("paid add-on that defaults on");
    expect(quote).not.toContain("off by default and never");
    expect(quote).toContain("shippingProtectionChosen");
  });

  it("payment-methods does not claim the card fee is absorbed by the merchant", () => {
    const payments = source("src/lib/payment-methods.ts");
    // quote-order.ts adds cardFee.amount on top of expectedTotal and discloses
    // it as its own row, so "NOT passed on to customers" was false.
    expect(payments).not.toContain("is NOT passed on to customers");
    expect(payments).toContain("enabled: true");
  });

  it("shipping.ts scopes its no-handling-fee promise to shipping.ts", () => {
    const shipping = source("src/lib/shipping.ts");
    // Shipping Protection and the card Service Fee are both added to the
    // charged total in quote-order.ts, so the module-wide claim could not be
    // read as a claim about the order.
    expect(shipping).not.toContain("the only charges added to");
    expect(shipping).toContain("THIS MODULE adds no service/handling fee");
  });

  it("catalog.ts does not claim reserve_inventory ignores an untracked row", () => {
    const catalog = source("src/lib/catalog.ts");
    const sql = source("src/lib/sql/inventory-enforce-positive-stock.sql");
    expect(sql).toContain("(track_inventory = true or inventory_quantity > 0)");
    expect(catalog).not.toContain("reserve_inventory() lets it through without a hold");
  });
});

// ---------------------------------------------------------------------------
// CFG-13 — DEFAULT_PROFIT_SETTINGS vs DEFAULT_PROFIT_CONFIG.
// ---------------------------------------------------------------------------
describe("CFG-13: the profit defaults have one home", () => {
  it("DEFAULT_PROFIT_SETTINGS is built from the shared constants", () => {
    expect(DEFAULT_PROFIT_SETTINGS.processingFeePercent).toBe(PROCESSING_FEE_DEFAULT_PERCENT);
    expect(DEFAULT_PROFIT_SETTINGS.worstCaseUnitCost).toBe(WORST_CASE_UNIT_COST_DEFAULT);
  });

  it("carries no literal of its own", () => {
    // Every importer of DEFAULT_PROFIT_SETTINGS is a test, and no file imports
    // both it and DEFAULT_PROFIT_CONFIG, so an inlined literal here could drift
    // from the value the live checkout runs on with the suite green.
    const engine = source("src/lib/profit-engine.ts");
    expect(engine).toContain("worstCaseUnitCost: WORST_CASE_UNIT_COST_DEFAULT");
    expect(engine).toContain("processingFeePercent: PROCESSING_FEE_DEFAULT_PERCENT");
  });
});

// ---------------------------------------------------------------------------
// CFG-14 — the approval email's own copies of the three ambassador rates.
// ---------------------------------------------------------------------------
describe("CFG-14: the approval email quotes the programme defaults", () => {
  it("renders whatever the shared constants say, not baked-in 10/20/10", async () => {
    // Behavioural, and it can only pass with the fix: the literals and the
    // constants AGREE today, so the mock is what separates "reads the
    // programme default" from "happens to print the same number".
    vi.resetModules();
    vi.doMock("@/lib/admin-control-shared", () => ({
      DEFAULT_REFERRAL_DISCOUNT_PERCENT: 17,
      DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT: 23,
      DEFAULT_AMBASSADOR_COMMISSION_PERCENT: 29,
    }));
    try {
      const { ambassadorApprovedTemplate } = await import("@/lib/email/templates");
      const rendered = ambassadorApprovedTemplate({
        name: "Test Ambassador",
        referralCode: "TESTCODE",
        dashboardUrl: "https://example.test/account/ambassador",
      });
      // The two discount/commission bullets became rows of the rate table when
      // the approval email was trimmed to a transactional shape. The assertion
      // is the same one — each shared constant reaches the rendered email —
      // read against the label that names it.
      expect(rendered.html).toContain("customers who use it get <strong>17% off");
      expect(rendered.html).toMatch(/Your own discount<\/td>\s*<td[^>]*>23%/);
      expect(rendered.html).toMatch(/Your commission<\/td>\s*<td[^>]*>29%/);
    } finally {
      vi.doUnmock("@/lib/admin-control-shared");
      vi.resetModules();
    }
  });

  it("the unmocked defaults are still 10 / 20 / 10", () => {
    expect(DEFAULT_REFERRAL_DISCOUNT_PERCENT).toBe(10);
    expect(DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT).toBe(20);
    expect(DEFAULT_AMBASSADOR_COMMISSION_PERCENT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// DUP-12 — a local copy of the points redemption rate on the checkout page.
// ---------------------------------------------------------------------------
describe("DUP-12: checkout values points through the shared helper", () => {
  it("has no `pointsBalance / 100`", () => {
    const checkout = source("src/app/checkout/page.tsx");
    expect(checkout).not.toContain("pointsBalance / 100");
    expect(checkout).toContain("formatCartCurrency(pointsToDollars(pointsBalance))");
  });
});

// ---------------------------------------------------------------------------
// M-04 — the checkout profit guard substituted a stale parent cost.
// ---------------------------------------------------------------------------
describe("M-04: the profit guard refuses the parent cost on a dose-bearing slug", () => {
  it("resolveUnitCostCents — the canonical rule the guard now mirrors — refuses it", () => {
    const byDose = new Map<string, number>();
    const bySlug = new Map<string, number>([["ghrp-2", 12]]);
    const withDoses = new Set<string>(["ghrp-2"]);
    // Dose rows exist, no cost on the chosen one: null, never the $12 parent.
    expect(resolveUnitCostCents("ghrp-2", "dose-a", byDose, bySlug, withDoses)).toBeNull();
    // No dose rows: the parent IS the product's only cost and is used.
    expect(resolveUnitCostCents("bac-water", undefined, byDose, new Map([["bac-water", 8]]), new Set())).toBe(800);
  });

  it("consults slugsWithDoses, exactly as resolveUnitCostCents does", () => {
    // The guard is assembled inline inside quoteOrder, which needs Supabase, so
    // this is asserted on the source. The behaviour it pins: for a slug that has
    // dose rows but no cost on the chosen dose, the guard must price at
    // worstCaseUnitCost. It used to fall back to products.product_cost_cents —
    // an inherited EvoLabs figure that sits BELOW the $33 worst case on a large
    // share of the catalogue, so the substitution understated COGS and loosened
    // the floor rather than tightening it as its comment claimed.
    const quote = source("src/lib/quote-order.ts");
    const guard = quote.slice(quote.indexOf("const guardProductCost"), quote.indexOf("const guardProfit"));
    expect(guard).toContain("slugsWithDoses.has(slug)");
    expect(guard).toContain("profitSettings.worstCaseUnitCost");
    expect(quote).not.toContain("This can only tighten the floor for high-cost SKUs");
  });
});

// ---------------------------------------------------------------------------
// SOT-08 — the floor predicate had two homes.
// ---------------------------------------------------------------------------
describe("SOT-08: one floor predicate, used by the live checkout", () => {
  const settings = { minProfitPercent: 20, minProfitDollars: 5, worstCaseUnitCost: 33, processingFeePercent: 8 };
  const breakdown = (grossProfit: number, discountedSubtotal: number, grossMarginPercent: number) => ({
    discount: { amount: 0, components: [], label: "resolved" },
    discountedSubtotal,
    commission: 0,
    revenue: discountedSubtotal,
    productCost: 0,
    processingFee: 0,
    shippingCost: 0,
    grossProfit,
    grossMarginPercent,
    taxCollected: 0,
    amountCharged: discountedSubtotal,
  });

  it("blocks on the dollar floor", () => {
    expect(meetsFloor(breakdown(4, 100, 90), settings)).toBe(false);
  });

  it("blocks on the percent floor", () => {
    expect(meetsFloor(breakdown(10, 100, 10), settings)).toBe(false);
  });

  it("ignores the percent floor at zero subtotal — 0% there is a sentinel, not a margin", () => {
    expect(meetsFloor(breakdown(10, 0, 0), settings)).toBe(true);
  });

  it("passes when both floors are met", () => {
    expect(meetsFloor(breakdown(30, 100, 30), settings)).toBe(true);
  });

  it("the live checkout calls it instead of restating it", () => {
    const quote = source("src/lib/quote-order.ts");
    expect(quote).toContain("if (!meetsFloor(guardProfit, profitSettings)) {");
    expect(quote).not.toContain("guardProfit.grossMarginPercent < profitSettings.minProfitPercent");
  });
});

// ---------------------------------------------------------------------------
// M-13 — a guard-internal margin that must never be rendered.
// ---------------------------------------------------------------------------
describe("M-13: grossMarginPercent is documented as guard-internal", () => {
  it("says so at the field, so a future reader does not surface the 0 sentinel", () => {
    const engine = source("src/lib/profit-engine.ts");
    expect(engine).toContain("GUARD-INTERNAL ONLY, NEVER RENDERED");
    expect(engine).toContain("marginPercentOf");
  });
});

// ---------------------------------------------------------------------------
// F-TAX-08 — a runbook querying a table that does not exist.
// ---------------------------------------------------------------------------
describe("F-TAX-08: the Block F runbook reads the store that actually exists", () => {
  const doc = source("docs/findings/BLOCK-F-PRODUCTION-CHANGES.md");

  it("queries the admin_control_current view, not a public.admin_control table", () => {
    expect(doc).not.toContain("public.admin_control\n");
    expect(doc).not.toContain("from public.admin_control ");
    expect(doc).toContain("from public.admin_control_current");
  });

  it("does not offer an UPDATE against an append-only store", () => {
    expect(doc).toContain("there is nothing to UPDATE");
  });

  it("cites a line number that really writes the key", () => {
    // Derived from the doc rather than hard-coded, so this goes red exactly
    // when the cite and the code disagree — which is the finding — and not
    // merely because the file grew a line somewhere above.
    const cites = [...doc.matchAll(/admin-control-center-client\.tsx:(\d+)/g)];
    expect(cites.length).toBeGreaterThan(0);
    const lines = adminClient.split("\n");
    for (const [, lineNumber] of cites) {
      expect(lines[Number(lineNumber) - 1]).toContain('{ section: "profit", key: "count_sales_tax_as_profit"');
    }
  });
});
