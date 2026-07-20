// Elite-tier "Exclusive Buy In Bulk Savings" program math - shared
// identically by the client cart preview and the server checkout total
// (same reasoning as bundle-pricing.ts/shipping.ts). Eligibility (highest
// active-paying-member tier only) is resolved separately server-side and
// passed in here as a plain boolean, so this module has no DB access.

export interface BulkSavingsConfig {
  enabled: boolean;
  tier1Threshold: number;
  tier1Percent: number;
  tier2Threshold: number;
  tier2Percent: number;
}

export const DEFAULT_BULK_SAVINGS_CONFIG: BulkSavingsConfig = {
  enabled: true,
  tier1Threshold: 500,
  tier1Percent: 5,
  tier2Threshold: 1000,
  tier2Percent: 12,
};

export type BulkSavingsTier = "5_percent" | "12_percent";

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateBulkSavingsDiscount(
  subtotal: number,
  isEligible: boolean,
  config: BulkSavingsConfig,
): { tier: BulkSavingsTier | null; amount: number; percent: number } {
  if (!isEligible || !config.enabled) {
    return { tier: null, amount: 0, percent: 0 };
  }

  if (subtotal >= config.tier2Threshold) {
    return { tier: "12_percent", amount: roundMoney(subtotal * (config.tier2Percent / 100)), percent: config.tier2Percent };
  }

  if (subtotal >= config.tier1Threshold) {
    return { tier: "5_percent", amount: roundMoney(subtotal * (config.tier1Percent / 100)), percent: config.tier1Percent };
  }

  return { tier: null, amount: 0, percent: 0 };
}

export function getBulkSavingsProgress(
  subtotal: number,
  isEligible: boolean,
  config: BulkSavingsConfig,
): { nextPercent: number; amountRemaining: number } | null {
  if (!isEligible || !config.enabled) {
    return null;
  }

  if (subtotal < config.tier1Threshold) {
    return { nextPercent: config.tier1Percent, amountRemaining: roundMoney(config.tier1Threshold - subtotal) };
  }

  if (subtotal < config.tier2Threshold) {
    return { nextPercent: config.tier2Percent, amountRemaining: roundMoney(config.tier2Threshold - subtotal) };
  }

  return null;
}
