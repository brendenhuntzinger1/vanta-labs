import { describe, expect, it } from "vitest";
import {
  evaluateRecoveryOffer,
  RECOVERY_FLOOR_ENFORCED,
  RECOVERY_OFFER_FLOOR_CENTS,
} from "@/lib/cart-recovery-offer-floor";

// ---------------------------------------------------------------------------
// P0-4. THE OVERRIDE PATH HAD NO ARITHMETIC ANYWHERE.
//
// The banded ladder sizes a gift against cart value and is defensible by
// construction. An override is a row naming an offer_key for one cart, written
// by hand, and the admin resend attaches whatever it says — so the most
// expensive gift in the catalogue could reach the cheapest cart in the store
// with nothing in between having an opinion about it.
//
// Worked at the store's live figures: COGS 17.57% of revenue, postage $7.79,
// processor 8% ESTIMATED. Those are the numbers below.
// ---------------------------------------------------------------------------

const LIVE = {
  productCostRatio: 0.1757,
  postageCents: 779,
  processorFeePercent: 8,
  // Keyed by the CANONICAL slug the offer catalogue names (BAC_WATER_SLUG
  // is "recon-water"), because that is the key the lookup uses.
  giftCostCents: { "ghk-cu": 2288, "recon-water": 143, klow: 2507 },
};

describe("an offer that costs more than the order leaves", () => {
  it("catches the free vial attached to a small cart", () => {
    // $40 cart: about $22 of contribution, against $22.88 of gift at COGS.
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 4_000,
      inputs: LIVE,
    });
    expect(verdict.belowFloor).toBe(true);
    expect(verdict.contributionBeforeCents).toBeGreaterThan(0);
    expect(verdict.contributionAfterCents).toBeLessThan(0);
  });

  it("says so in words an operator can act on, and calls the fee estimated", () => {
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 4_000,
      inputs: LIVE,
    });
    expect(verdict.summary).toMatch(/below the \$0\.00 floor/);
    expect(verdict.summary).toMatch(/ship at a loss/);
    expect(verdict.summary).toMatch(/estimated/i);
  });

  it("counts the percentage as well as the product", () => {
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_bac_water_10",
      cartValueCents: 10_000,
      inputs: LIVE,
    });
    expect(verdict.percentCostCents).toBe(1_000);      // 10% of $100
    expect(verdict.giftCostCents).toBe(143);            // the recon water at COGS
    expect(verdict.incentiveCents).toBe(1_143);
  });
});

describe("an offer the order can carry", () => {
  it("passes the same vial on a cart that can afford it", () => {
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 15_000,
      inputs: LIVE,
    });
    expect(verdict.belowFloor).toBe(false);
    expect(verdict.summary).toMatch(/Above the floor/);
  });

  it("charges nothing for free shipping, because this store ships free anyway", () => {
    // A statement about Vanta, not about shipping: everything has shipped free
    // since 2026-09-06, so this gift waives a charge nobody was going to pay.
    // The postage itself is already a cost on every order, gift or no gift.
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_shipping",
      cartValueCents: 5_000,
      inputs: LIVE,
    });
    expect(verdict.incentiveCents).toBe(0);
    expect(verdict.contributionAfterCents).toBe(verdict.contributionBeforeCents);
  });

  it("counts an unpriced gift as free but refuses to call that a clean pass", () => {
    // A guessed COGS on the screen that decides what to give away is worse than
    // a known gap — listGiftableProducts returns null for a product with no
    // dose cost precisely so somebody fills it in. But a silent zero would turn
    // the guardrail off for exactly the gift it could not price, so the gap is
    // carried forward instead of absorbed. Recon Water has four resolvable
    // slugs and only one of them is in the products table, which is how this
    // happens in practice rather than in theory.
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 20_000,
      inputs: { ...LIVE, giftCostCents: {} },
    });
    expect(verdict.giftCostCents).toBe(0);
    expect(verdict.giftCostKnown).toBe(false);
    expect(verdict.summary).toMatch(/is not recorded/);
    expect(verdict.summary).toMatch(/optimistic/);
  });

  it("knows the cost when it has one", () => {
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 20_000,
      inputs: LIVE,
    });
    expect(verdict.giftCostKnown).toBe(true);
    expect(verdict.giftCostCents).toBe(2_288);
  });

  it("an offer with no product at all is not 'unknown cost'", () => {
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_shipping",
      cartValueCents: 20_000,
      inputs: { ...LIVE, giftCostCents: {} },
    });
    expect(verdict.giftCostKnown).toBe(true);
  });
});

describe("report-only, and visibly so", () => {
  it("does not enforce yet — the flag is the whole switch", () => {
    // An override exists because a human has a reason the rules do not know.
    // Turning a brand-new floor into a refusal on day one would break that for
    // the one person who cannot ask anybody else to unblock it.
    expect(RECOVERY_FLOOR_ENFORCED).toBe(false);
    const verdict = evaluateRecoveryOffer({
      offerKey: "winback_60_free_ghkcu",
      cartValueCents: 4_000,
      inputs: LIVE,
    });
    expect(verdict.belowFloor).toBe(true);
    expect(verdict.enforced).toBe(false);
    expect(verdict.summary).toMatch(/Reported only; the send was not stopped/);
  });

  it("the floor is zero — 'leaves anything at all', not a margin target", () => {
    // A recovery offer that merely thins the margin can still be right, and
    // that judgement is the operator's. This asks the one question that is not
    // a matter of taste.
    expect(RECOVERY_OFFER_FLOOR_CENTS).toBe(0);
  });
});
