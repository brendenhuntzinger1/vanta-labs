import { describe, expect, it } from "vitest";
import { tierEconomics, DEFAULT_RECOVERY_TIERS, type TierEconomicsInputs } from "@/lib/cart-recovery-tiers";

// ---------------------------------------------------------------------------
// P0-8. THE BAND EDITOR MODELLED NO PROCESSOR COST, ON A PREMISE THAT IS FALSE.
//
// cart-recovery-tiers.ts carried: "The card fee is deliberately absent. This
// store passes a 3% service fee to the customer on card payments, so it is not
// the store's cost."
//
// Production says otherwise. admin_control_current holds
// payment_methods/card_processing_fee as {enabled: false, percentage: 0}, and
// the fifteen paid orders have collected $0.00 in card_processing_fee. The fee
// is absorbed by the store, so leaving it out overstated every margin on the
// one screen an operator uses to decide what an incentive costs.
//
// It is ESTIMATED, not settled — Vanta does not reconcile per-transaction
// processor cost here — so the value is the Control Center's conservative model
// and every surface that renders it has to say so.
// ---------------------------------------------------------------------------

const inputs = (processorFeePercent?: number): TierEconomicsInputs => ({
  productCostRatio: 0.1757, // live, revenue-weighted across the default doses, 2026-09-12
  postageCents: 779,        // live, the ten paid orders that record postage
  processorFeePercent,
  giftCostCents: { "ghk-cu": 365, "bac-water": 143, klow: 2507 },
  giftRetailCents: { "ghk-cu": 3999, "bac-water": 1499, klow: 11999 },
});

/** The $100-249 band: a GHK-Cu + Recon Water gift AND a 10% code. */
const bandWithPercent = DEFAULT_RECOVERY_TIERS[1];
/** The $500+ band: the biggest gift and no percentage. */
const topBand = DEFAULT_RECOVERY_TIERS[3];

describe("tier economics and the processor fee", () => {
  it("leaves every existing caller unchanged when no fee is given", () => {
    // Backward compatibility is the point: an omitted input must not silently
    // invent a cost, or every historical figure would move without a decision.
    const without = tierEconomics(bandWithPercent, 15_000, inputs(undefined));
    const zero = tierEconomics(bandWithPercent, 15_000, inputs(0));
    expect(without.netCents).toBe(zero.netCents);
    expect(without.estimatedProcessorFeeCents).toBe(0);
  });

  it("reduces net once the fee is modelled — the direction that was wrong", () => {
    const before = tierEconomics(topBand, 52_000, inputs(0));
    const after = tierEconomics(topBand, 52_000, inputs(8));
    expect(after.netCents).toBeLessThan(before.netCents);
    // 8% of a $520 cart with no percentage discount = $41.60.
    expect(after.estimatedProcessorFeeCents).toBe(4_160);
  });

  it("charges the fee on what is actually charged, not on the list price", () => {
    // A percentage discount reduces the processor's cut with it. That is the
    // one respect in which a discount is cheaper than it looks, and modelling
    // it wrongly would overstate the cost of the band that carries a code.
    const e = tierEconomics(bandWithPercent, 15_000, inputs(8));
    expect(e.percentCostCents).toBe(1_500);            // 10% of $150
    expect(e.estimatedProcessorFeeCents).toBe(1_080);  // 8% of $135, not of $150
  });

  it("keeps contribution-before-incentive on undiscounted revenue", () => {
    // contributionCents is the counterfactual the incentive is judged against:
    // what this cart would have left with no offer attached at all. So its fee
    // is the fee on the full price, not on the discounted one.
    const e = tierEconomics(bandWithPercent, 15_000, inputs(8));
    const cogs = Math.round(15_000 * 0.1757);
    expect(e.contributionCents).toBe(15_000 - cogs - 779 - Math.round(15_000 * 0.08));
  });

  it("still reports the gift as far cheaper than the percentage", () => {
    // The finding the whole ladder rests on has to survive the correction, or
    // the correction would have changed the strategy rather than the numbers.
    const e = tierEconomics(bandWithPercent, 15_000, inputs(8));
    expect(e.giftCostCents).toBeLessThan(e.percentCostCents);
    expect(e.perceivedValueCents).toBeGreaterThan(e.incentiveCents);
  });

  it("never reports a negative fee from a nonsense input", () => {
    const e = tierEconomics(topBand, 52_000, inputs(-5));
    expect(e.estimatedProcessorFeeCents).toBe(0);
  });
});
