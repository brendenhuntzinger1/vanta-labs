import { describe, expect, it } from "vitest";
import {
  calculateTaxAmount,
  DEFAULT_SALES_TAX_CONFIG,
  normalizeUsState,
  resolveSalesTax,
  US_STATE_TAX_TABLE,
  type SalesTaxConfig,
} from "@/lib/sales-tax";

const nexus = (states: string[], overrides: Record<string, number> = {}): SalesTaxConfig => ({
  nexusStates: states,
  rateOverrides: overrides,
});

describe("US_STATE_TAX_TABLE", () => {
  it("covers all 50 states + DC + PR with sane rates", () => {
    expect(Object.keys(US_STATE_TAX_TABLE)).toHaveLength(52);
    for (const [code, rule] of Object.entries(US_STATE_TAX_TABLE)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(rule.ratePercent).toBeGreaterThanOrEqual(0);
      expect(rule.ratePercent).toBeLessThan(13);
    }
  });

  it("no-sales-tax states carry a 0% rate", () => {
    for (const code of ["DE", "MT", "NH", "OR"]) {
      expect(US_STATE_TAX_TABLE[code].ratePercent).toBe(0);
    }
  });
});

describe("normalizeUsState", () => {
  it("accepts codes, full names, and messy casing/whitespace", () => {
    expect(normalizeUsState("TX")).toBe("TX");
    expect(normalizeUsState(" tx ")).toBe("TX");
    expect(normalizeUsState("Texas")).toBe("TX");
    expect(normalizeUsState("district of columbia")).toBe("DC");
    expect(normalizeUsState("New York")).toBe("NY");
  });

  it("rejects unknown values", () => {
    expect(normalizeUsState("")).toBeNull();
    expect(normalizeUsState(null)).toBeNull();
    expect(normalizeUsState("ZZ")).toBeNull();
    expect(normalizeUsState("Ontario")).toBeNull();
  });
});

describe("resolveSalesTax — nexus gating (only collect where required)", () => {
  it("collects for a nexus-state destination at the state rate", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "United States", state: "TX", config: nexus(["TX"]) });
    expect(q.collected).toBe(true);
    expect(q.ratePercent).toBe(US_STATE_TAX_TABLE.TX.ratePercent);
    expect(q.amount).toBe(calculateTaxAmount(100, US_STATE_TAX_TABLE.TX.ratePercent));
    expect(q.state).toBe("TX");
    expect(q.reason).toBe("collected");
  });

  it("collects $0 for a non-nexus destination", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "CA", config: nexus(["TX"]) });
    expect(q.amount).toBe(0);
    expect(q.collected).toBe(false);
    expect(q.reason).toBe("no_nexus");
  });

  it("collects nothing anywhere with no nexus configured (the default)", () => {
    for (const state of Object.keys(US_STATE_TAX_TABLE)) {
      const q = resolveSalesTax({ taxableAmount: 500, shippingAmount: 15, country: "USA", state, config: DEFAULT_SALES_TAX_CONFIG });
      expect(q.amount).toBe(0);
      expect(q.collected).toBe(false);
    }
  });

  it("normalizes nexus config entries too ('texas' matches a TX order)", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "Texas", config: nexus(["texas"]) });
    expect(q.collected).toBe(true);
    expect(q.state).toBe("TX");
  });

  it("never collects for a nexus state with no sales tax (OR/NH/DE/MT)", () => {
    for (const state of ["OR", "NH", "DE", "MT"]) {
      const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 10, country: "US", state, config: nexus([state]) });
      expect(q.amount).toBe(0);
      expect(q.reason).toBe("zero_rate");
    }
  });
});

describe("resolveSalesTax — base composition", () => {
  it("taxes shipping only in states that tax delivery charges", () => {
    // TX taxes shipping; CA does not.
    const tx = resolveSalesTax({ taxableAmount: 100, shippingAmount: 15, country: "US", state: "TX", config: nexus(["TX"]) });
    expect(tx.taxableBase).toBe(115);
    const ca = resolveSalesTax({ taxableAmount: 100, shippingAmount: 15, country: "US", state: "CA", config: nexus(["CA"]) });
    expect(ca.taxableBase).toBe(100);
  });

  it("applies the post-discount amount the caller passes (discounts reduce tax)", () => {
    const full = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "CA", config: nexus(["CA"]) });
    const discounted = resolveSalesTax({ taxableAmount: 80, shippingAmount: 0, country: "US", state: "CA", config: nexus(["CA"]) });
    expect(discounted.amount).toBeLessThan(full.amount);
  });

  it("zero/negative base → $0, reason zero_base", () => {
    for (const taxableAmount of [0, -25]) {
      const q = resolveSalesTax({ taxableAmount, shippingAmount: 15, country: "US", state: "TX", config: nexus(["TX"]) });
      expect(q.amount).toBe(0);
      expect(q.reason).toBe("zero_base");
    }
  });
});

describe("resolveSalesTax — destination edge cases", () => {
  it("non-US destinations collect $0 (not registered abroad)", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 25, country: "Canada", state: "Ontario", config: nexus(["TX", "CA"]) });
    expect(q.amount).toBe(0);
    expect(q.reason).toBe("non_us");
  });

  it("US order with no resolvable state collects $0 with reason no_state", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "", config: nexus(["TX"]) });
    expect(q.amount).toBe(0);
    expect(q.reason).toBe("no_state");
  });

  it("empty country defaults to domestic (matches shipping's preview rule)", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "", state: "TX", config: nexus(["TX"]) });
    expect(q.collected).toBe(true);
  });
});

describe("resolveSalesTax — admin rate overrides", () => {
  it("uses the override instead of the table rate", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "TX", config: nexus(["TX"], { TX: 8.25 }) });
    expect(q.ratePercent).toBe(8.25);
    expect(q.amount).toBe(8.25);
  });

  it("an override of 0 disables collection for that state", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "TX", config: nexus(["TX"], { TX: 0 }) });
    expect(q.amount).toBe(0);
    expect(q.reason).toBe("zero_rate");
  });

  it("ignores an override for a state the order doesn't ship to", () => {
    const q = resolveSalesTax({ taxableAmount: 100, shippingAmount: 0, country: "US", state: "CA", config: nexus(["CA"], { TX: 8.25 }) });
    expect(q.ratePercent).toBe(US_STATE_TAX_TABLE.CA.ratePercent);
  });
});

describe("resolveSalesTax — money invariants", () => {
  it("amount is always non-negative, cent-rounded, and proportional to the base", () => {
    for (const state of Object.keys(US_STATE_TAX_TABLE)) {
      for (const taxableAmount of [0.01, 9.99, 47.5, 100, 999.99, 5000]) {
        const q = resolveSalesTax({ taxableAmount, shippingAmount: 15, country: "US", state, config: nexus([state]) });
        expect(q.amount).toBeGreaterThanOrEqual(0);
        expect(Math.round(q.amount * 100) / 100).toBe(q.amount);
        // Tax never exceeds 13% of the taxable base (rate-table ceiling).
        expect(q.amount).toBeLessThanOrEqual(q.taxableBase * 0.13 + 0.01);
      }
    }
  });

  it("calculateTaxAmount: exact application, zero on empty base/rate", () => {
    expect(calculateTaxAmount(100, 7)).toBe(7);
    expect(calculateTaxAmount(0, 7)).toBe(0);
    expect(calculateTaxAmount(-5, 7)).toBe(0);
    expect(calculateTaxAmount(100, 0)).toBe(0);
    expect(calculateTaxAmount(100, -2)).toBe(0);
  });

  it("client preview and server quote agree for every state (same shared function)", () => {
    // The server (payment-service via tax-provider) and the checkout preview
    // call resolveSalesTax with identical inputs — assert determinism.
    for (const state of Object.keys(US_STATE_TAX_TABLE)) {
      const input = { taxableAmount: 123.45, shippingAmount: 15, country: "United States", state, config: nexus(["TX", "CA", "NY", state]) };
      expect(resolveSalesTax(input)).toEqual(resolveSalesTax({ ...input }));
    }
  });
});

// ---------------------------------------------------------------------------
// FLORIDA, PINNED — because it is the home state and the one nexus will be
// switched on first.
//
// Vanta Labs' registered address is San Antonio, FL 33576 (Pasco County), and
// as of 2026-08-28 `tax.nexus_states` in production is EMPTY. The store
// therefore collects $0 in every state, Florida included — the test above
// ("collects nothing anywhere with no nexus configured") is not a hypothetical,
// it is the live configuration.
//
// That is an owner decision, not a defect, and nothing here changes it. What
// these tests do is remove the second risk: that switching nexus on quietly
// starts collecting the WRONG number. Under-collecting leaves a liability;
// over-collecting owes refunds to customers. Both are worse than the current
// $0, because both are silent.
//
// So this pins exactly what a Florida order pays the moment "FL" is added, and
// nothing else changes by accident.
// ---------------------------------------------------------------------------
describe("Florida, the home state, the day nexus is switched on", () => {
  it("charges 7.0% — Florida's 6% state rate plus Pasco County's 1% surtax", () => {
    const q = resolveSalesTax({
      taxableAmount: 100,
      shippingAmount: 0,
      country: "United States",
      state: "FL",
      config: nexus(["FL"]),
    });

    expect(q.collected).toBe(true);
    expect(q.ratePercent).toBe(7.0);
    expect(q.amount).toBe(7.0);
    expect(q.reason).toBe("collected");
  });

  it("does NOT tax the shipping fee, which is correct for Florida", () => {
    // Florida taxes delivery only when it is not separately stated and the
    // buyer cannot avoid it. This store states shipping separately, so the
    // table's shippingTaxable: false is the right reading — and a $200 order
    // with $15 shipping must be taxed on $200, not $215.
    expect(US_STATE_TAX_TABLE.FL.shippingTaxable).toBe(false);

    const q = resolveSalesTax({
      taxableAmount: 200,
      shippingAmount: 15,
      country: "US",
      state: "FL",
      config: nexus(["FL"]),
    });

    expect(q.amount).toBe(calculateTaxAmount(200, 7.0));
    expect(q.amount).not.toBe(calculateTaxAmount(215, 7.0));
  });

  it("still collects nothing outside Florida when only FL is registered", () => {
    // The reason this matters: registering one state must not start collecting
    // in forty-nine others. Each of those would be tax taken with no obligation
    // to remit it, which is the harder mistake to unwind.
    for (const state of Object.keys(US_STATE_TAX_TABLE).filter((s) => s !== "FL")) {
      const q = resolveSalesTax({
        taxableAmount: 100,
        shippingAmount: 10,
        country: "US",
        state,
        config: nexus(["FL"]),
      });
      expect(q.amount, `expected $0 for ${state}`).toBe(0);
      expect(q.collected).toBe(false);
      expect(q.reason).toBe("no_nexus");
    }
  });

  it("honours an admin override, so a better local figure wins over the table", () => {
    // The table is a population-weighted county average, not a rooftop rate.
    // If the owner's shipping mix justifies a different Florida figure, the
    // Control Center override is the supported way to say so — and it must
    // actually take effect, or the override screen is decoration.
    const q = resolveSalesTax({
      taxableAmount: 100,
      shippingAmount: 0,
      country: "US",
      state: "FL",
      config: nexus(["FL"], { FL: 6.5 }),
    });

    expect(q.ratePercent).toBe(6.5);
    expect(q.amount).toBe(6.5);
  });
});
