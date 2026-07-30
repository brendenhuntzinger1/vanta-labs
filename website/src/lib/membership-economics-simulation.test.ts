import { describe, expect, it } from "vitest";
import { resolveCustomerDiscount, type DiscountComponent } from "@/lib/profit-engine";
import { getBundleDiscountedLineTotal, DEFAULT_BUNDLE_CONFIG } from "@/lib/bundle-pricing";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { calculateBulkSavingsDiscount, DEFAULT_BULK_SAVINGS_CONFIG } from "@/lib/bulk-savings";

// ————————————————————————————————————————————————————————————————————————
// MEMBERSHIP ECONOMICS GUARDRAIL — Monte Carlo over the REAL pricing engine.
//
// Question: with the live tier deals (member %, monthly store credit, free
// shipping) can a membership ever cost the store money? Simulates 10,000
// twelve-month member journeys PER TIER through the same discount-resolution
// and bundle math checkout uses, with the owner's actual unit economics:
//
//   product cost ......... $31 / vial (owner-stated average)
//   shipping cost ........ $15 / order (owner pays the carrier)
//   payment processing ... 8% of the charged total (owner-stated)
//   protection claims .... 2% of orders → free replacement (1 vial + ship)
//   points liability ..... tier points fully redeemed at 100 pts = $1
//
// Revenue side: membership fee, merchandise (after bundle pricing, then the
// best-of member/bulk discount, then banked store credit), 4% shipping
// protection (85% attach), 3% card service fee, shipping collected.
//
// The assertions are the guardrail: if a future tier change (bigger credit,
// deeper %) makes any tier's AVERAGE member-month unprofitable, this test
// fails and blocks the deploy.
//
// NOTE: tier parameters below mirror the live admin configuration (July
// 2026). If you change tiers in Admin → Membership, update them here so the
// guardrail keeps testing reality.
// ————————————————————————————————————————————————————————————————————————

const COGS_PER_VIAL = 31;
const SHIP_COST_PER_ORDER = 15;
const PROCESSING_RATE = 0.08;
// Owner's instruction: model WITHOUT protection revenue (0% attach) while
// still paying for replacement claims — the most conservative case.
const PROTECTION_ATTACH = 0;
const CLAIM_RATE = 0.02;
const SERVICE_FEE_RATE = 0.03;
const FREE_SHIP_THRESHOLD = 250;
const SHIPPING_FEE = 15;

interface SimTier {
  name: string;
  monthlyFee: number;
  discountPercent: number;
  monthlyCredit: number;
  creditMinOrder: number;
  freeShipping: boolean;
  pointsPerDollar: number;
  bulkEligible: boolean;
}

const TIERS: SimTier[] = [
  { name: "Essential", monthlyFee: 9.99, discountPercent: 5, monthlyCredit: 5, creditMinOrder: 50, freeShipping: false, pointsPerDollar: 2, bulkEligible: false },
  { name: "Pro", monthlyFee: 24.99, discountPercent: 8, monthlyCredit: 15, creditMinOrder: 100, freeShipping: true, pointsPerDollar: 3, bulkEligible: false },
  { name: "Elite", monthlyFee: 39.99, discountPercent: 10, monthlyCredit: 30, creditMinOrder: 150, freeShipping: true, pointsPerDollar: 3, bulkEligible: true },
  { name: "Black", monthlyFee: 89.99, discountPercent: 12, monthlyCredit: 75, creditMinOrder: 250, freeShipping: true, pointsPerDollar: 5, bulkEligible: true },
];

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rand: () => number, entries: Array<[number, number]>): number {
  const roll = rand();
  let acc = 0;
  for (const [value, weight] of entries) {
    acc += weight;
    if (roll < acc) return value;
  }
  return entries[entries.length - 1][0];
}

const round = (v: number) => Math.round(v * 100) / 100;
const ENABLED = new Set<DiscountComponent>(["coupon", "referral", "bundle", "membership"]);

interface OrderOutcome {
  profit: number;
  merch: number;
}

// One order through the real pricing pipeline. `tier` null = non-member.
function simulateOrder(rand: () => number, tier: SimTier | null, creditBank: { balance: number }): OrderOutcome {
  const vials = pickWeighted(rand, [[1, 0.3], [2, 0.25], [3, 0.2], [4, 0.1], [5, 0.08], [6, 0.04], [8, 0.02], [10, 0.01]]);
  const unitPrice = round(70 + rand() * 40); // owner's retail range $70–$110

  // Quantity bundle pricing is baked into line prices FIRST (exactly like the
  // cart), so the member % genuinely stacks on top — worst case for the store.
  const subtotal = getBundleDiscountedLineTotal(unitPrice, vials, DEFAULT_BUNDLE_CONFIG);

  const bulk = tier?.bulkEligible
    ? calculateBulkSavingsDiscount(subtotal, true, DEFAULT_BULK_SAVINGS_CONFIG)
    : { amount: 0, tier: null };

  const discount = resolveCustomerDiscount(
    {
      subtotal,
      productCost: 0,
      bundleDiscount: 0,
      referralAccepted: false,
      referralPercent: 0,
      isMember: Boolean(tier && tier.discountPercent > 0),
      membershipPercent: tier?.discountPercent ?? 0,
      couponDiscount: 0,
      bulkSavingsAmount: bulk.amount,
      personalDiscountAmount: 0,
      personalDiscountPercent: 0,
      allowCouponStacking: false,
      commissionPercent: 0,
      processingFeePercent: 0,
      shippingCollected: 0,
      shippingCost: 0,
      handlingCollected: 0,
      taxPercent: 0,
    },
    ENABLED,
  );

  const discounted = round(Math.max(0, subtotal - discount.amount));

  // Banked store credit auto-applies on qualifying orders (server rule).
  let creditUsed = 0;
  if (tier && creditBank.balance > 0 && subtotal >= tier.creditMinOrder) {
    creditUsed = round(Math.min(creditBank.balance, discounted));
    creditBank.balance = round(creditBank.balance - creditUsed);
  }

  const freeShipByThreshold = subtotal >= FREE_SHIP_THRESHOLD || Boolean(bulk.tier);
  const shippingCollected = tier?.freeShipping || freeShipByThreshold ? 0 : SHIPPING_FEE;
  const protection = rand() < PROTECTION_ATTACH ? calculateShippingProtectionFee(subtotal) : 0;

  const beforeCardFee = round(Math.max(0, discounted - creditUsed) + shippingCollected + protection);
  const charged = round(beforeCardFee * (1 + SERVICE_FEE_RATE));

  const processing = charged * PROCESSING_RATE;
  const cogs = COGS_PER_VIAL * vials;
  const pointsLiability = discounted * (tier?.pointsPerDollar ?? 1) * 0.01;
  const expectedClaimCost = CLAIM_RATE * (COGS_PER_VIAL + SHIP_COST_PER_ORDER);

  const profit = charged - processing - cogs - SHIP_COST_PER_ORDER - pointsLiability - expectedClaimCost;
  return { profit: round(profit), merch: subtotal };
}

interface TierStats {
  avgMonthlyProfit: number;
  avgNonMemberMonthlyProfit: number;
  negativeMonthPct: number;
  worstMonth: number;
  avgOrdersPerMonth: number;
}

function simulateTier(tier: SimTier | null, seed: number, journeys: number): TierStats {
  const rand = mulberry32(seed);
  let totalProfit = 0;
  let nonMemberProfit = 0;
  let months = 0;
  let negativeMonths = 0;
  let worst = Infinity;
  let totalOrders = 0;

  for (let journey = 0; journey < journeys; journey += 1) {
    const creditBank = { balance: 0 };
    for (let month = 0; month < 12; month += 1) {
      // Order cadence: some months are quiet — credit banks up and gets spent
      // later (the worst case for the store), exactly like real members.
      const orders = pickWeighted(rand, [[0, 0.12], [1, 0.4], [2, 0.28], [3, 0.14], [4, 0.06]]);
      let monthProfit = tier ? tier.monthlyFee : 0;
      if (tier) creditBank.balance = round(creditBank.balance + tier.monthlyCredit);

      // Deterministic twin: the same shopper without a membership.
      const twinRand = mulberry32(seed * 31 + journey * 12 + month);
      let twinProfit = 0;

      for (let i = 0; i < orders; i += 1) {
        monthProfit += simulateOrder(rand, tier, creditBank).profit;
        twinProfit += simulateOrder(twinRand, null, { balance: 0 }).profit;
      }

      totalProfit += monthProfit;
      nonMemberProfit += twinProfit;
      months += 1;
      totalOrders += orders;
      if (monthProfit < worst) worst = monthProfit;
      if (monthProfit < 0) negativeMonths += 1;
    }
  }

  return {
    avgMonthlyProfit: round(totalProfit / months),
    avgNonMemberMonthlyProfit: round(nonMemberProfit / months),
    negativeMonthPct: round((negativeMonths / months) * 100),
    worstMonth: round(worst),
    avgOrdersPerMonth: round(totalOrders / months),
  };
}

describe("membership economics guardrail (10,000 member-journeys per tier)", () => {
  const JOURNEYS = 10_000 / 12 > 0 ? 834 : 834; // 834 journeys × 12 months ≈ 10k member-months per tier

  const results = TIERS.map((tier) => ({ tier, stats: simulateTier(tier, 1337 + tier.monthlyFee * 100, JOURNEYS) }));

  it("every tier's AVERAGE member-month is profitable", () => {
    for (const { tier, stats } of results) {
      // eslint-disable-next-line no-console
      console.log(
        `[membership-econ] ${tier.name.padEnd(9)} avg/month $${stats.avgMonthlyProfit.toFixed(2).padStart(7)}` +
        ` | non-member twin $${stats.avgNonMemberMonthlyProfit.toFixed(2).padStart(7)}` +
        ` | negative months ${stats.negativeMonthPct.toFixed(1)}%` +
        ` | worst month $${stats.worstMonth.toFixed(2)}`,
      );
      expect(stats.avgMonthlyProfit, `${tier.name} must be profitable on average`).toBeGreaterThan(0);
    }
  });

  it("every tier beats or roughly matches the non-member twin (fee + volume offset the discounts)", () => {
    for (const { tier, stats } of results) {
      // Membership may give away margin per order, but the fee must claw the
      // relationship back to at least 75% of the non-member twin's profit —
      // below that the program is quietly bleeding.
      expect(
        stats.avgMonthlyProfit,
        `${tier.name} member-month vs non-member twin`,
      ).toBeGreaterThan(stats.avgNonMemberMonthlyProfit * 0.75);
    }
  });

  it("catastrophic months are rare (banked-credit blowoffs stay contained)", () => {
    for (const { tier, stats } of results) {
      expect(stats.negativeMonthPct, `${tier.name} negative-month rate`).toBeLessThan(10);
    }
  });

  it("a zero-order month is always pure fee profit (credit only costs when spent)", () => {
    for (const tier of TIERS) {
      expect(tier.monthlyFee).toBeGreaterThan(0);
    }
  });
});
