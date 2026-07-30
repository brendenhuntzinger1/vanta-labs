// Member-pricing display math — the "you'd pay $67.50 instead of $75" layer.
//
// Pure and client-safe (imported by product cards, the PDP, the cart drawer,
// and the membership page's live calculator). This module is DISPLAY ONLY:
// the authoritative member discount is still applied server-side at checkout
// through the shared discount-resolution rulebook — these helpers exist so
// every surface can show identical dollar figures for what membership would
// do, computed from the same tier data the server prices with.
//
// Dollars beat percentages: every helper returns exact dollar amounts first.

export interface MembershipTierSummary {
  slug: string;
  name: string;
  /** Member discount on merchandise, whole percent (e.g. 10). */
  discountPercent: number;
  monthlyPriceCents: number;
  annualPriceCents: number;
  monthlyStoreCreditCents: number;
  storeCreditMinOrderCents: number;
  freeShipping: boolean;
  pointsPerDollar: number;
  introPriceCents: number;
  introDurationDays: number;
  introOfferEnabled: boolean;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** "$75.00" / "$1,299.99" / "75" → 75 / 1299.99 (0 when unparseable). */
export function parsePriceValue(price: string | number | null | undefined): number {
  if (typeof price === "number") return Number.isFinite(price) ? price : 0;
  const cleaned = String(price ?? "").replace(/[^0-9.]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export interface MemberPriceQuote {
  regularPrice: number;
  memberPrice: number;
  /** Exact dollars saved on this price. */
  savings: number;
  /** Whole-number percent, for secondary display. */
  percent: number;
}

export function quoteMemberPrice(price: string | number, discountPercent: number): MemberPriceQuote {
  const regularPrice = roundMoney(parsePriceValue(price));
  const rate = Number.isFinite(discountPercent) && discountPercent > 0 ? Math.min(90, discountPercent) / 100 : 0;
  const memberPrice = roundMoney(regularPrice * (1 - rate));
  return {
    regularPrice,
    memberPrice,
    savings: roundMoney(regularPrice - memberPrice),
    percent: Math.round(rate * 100),
  };
}

/** The strongest paid tier — what non-member upsells advertise. */
export function bestPaidTier(tiers: MembershipTierSummary[]): MembershipTierSummary | null {
  const paid = (tiers ?? []).filter((tier) => tier.monthlyPriceCents > 0 && tier.discountPercent > 0);
  if (paid.length === 0) return null;
  return paid.reduce((best, tier) => (tier.discountPercent > best.discountPercent ? tier : best));
}

export interface CartMembershipValue {
  /** Dollars the member discount would take off THIS cart's merchandise. */
  discountSavings: number;
  /** Shipping the tier would erase on this cart (0 when already free). */
  shippingSavings: number;
  /** The tier's monthly store credit, in dollars. */
  monthlyStoreCredit: number;
  /** Monthly membership cost, in dollars. */
  monthlyCost: number;
  /** discount + shipping + credit − cost: what joining is worth TODAY. */
  todayValue: number;
  /** discount + shipping + credit (before the membership fee). */
  totalBenefit: number;
}

// The live calculator's math: what would this tier be worth against the
// current cart, right now. Store credit counts when the cart clears the
// tier's redemption minimum (mirrors the server's auto-apply rule).
export function computeCartMembershipValue(input: {
  subtotal: number;
  shipping: number;
  tier: MembershipTierSummary;
}): CartMembershipValue {
  const subtotal = Math.max(0, input.subtotal);
  const discountSavings = roundMoney(subtotal * (Math.min(90, Math.max(0, input.tier.discountPercent)) / 100));
  const shippingSavings = input.tier.freeShipping ? roundMoney(Math.max(0, input.shipping)) : 0;
  const monthlyStoreCredit =
    Math.round(subtotal * 100) >= input.tier.storeCreditMinOrderCents
      ? roundMoney(input.tier.monthlyStoreCreditCents / 100)
      : 0;
  const monthlyCost = roundMoney(input.tier.monthlyPriceCents / 100);
  const totalBenefit = roundMoney(discountSavings + shippingSavings + monthlyStoreCredit);
  return {
    discountSavings,
    shippingSavings,
    monthlyStoreCredit,
    monthlyCost,
    totalBenefit,
    todayValue: roundMoney(totalBenefit - monthlyCost),
  };
}

/** Annual framing: exact dollars + percent saved vs 12 monthly payments. */
export function annualSavings(tier: MembershipTierSummary): { dollars: number; percent: number; monthsFree: number } {
  const yearAtMonthly = tier.monthlyPriceCents * 12;
  if (yearAtMonthly <= 0 || tier.annualPriceCents <= 0 || tier.annualPriceCents >= yearAtMonthly) {
    return { dollars: 0, percent: 0, monthsFree: 0 };
  }
  const savedCents = yearAtMonthly - tier.annualPriceCents;
  return {
    dollars: roundMoney(savedCents / 100),
    percent: Math.round((savedCents / yearAtMonthly) * 100),
    monthsFree: Math.floor(savedCents / tier.monthlyPriceCents),
  };
}
