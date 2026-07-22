import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTION_RULES,
  normalizePromotionRules,
  resolvePromotions,
  type PromotionRulesConfig,
} from "@/lib/promotion-engine";
import { resolveBestDiscount } from "@/lib/discount-resolution";

const cfg = (overrides: Partial<PromotionRulesConfig>): PromotionRulesConfig =>
  normalizePromotionRules({ ...DEFAULT_PROMOTION_RULES, ...overrides });

describe("promotion engine — default config parity", () => {
  it("with defaults, reproduces greatest-wins (one discount, no stacking)", () => {
    const cases = [
      [{ type: "member_pricing", amount: 10 }, { type: "ambassador", amount: 15 }, { type: "coupon", amount: 12 }],
      [{ type: "referral", amount: 8 }, { type: "buy3get1", amount: 20 }],
      [{ type: "bulk_savings", amount: 30 }, { type: "member_pricing", amount: 25 }],
      [{ type: "coupon", amount: 0 }, { type: "ambassador", amount: 0 }],
    ] as const;
    for (const candidates of cases) {
      const engine = resolvePromotions([...candidates], DEFAULT_PROMOTION_RULES);
      const legacy = resolveBestDiscount([...candidates]);
      expect(engine.totalDiscount).toBe(legacy?.amount ?? 0);
    }
  });

  it("returns zero when everything is zero", () => {
    expect(resolvePromotions([{ type: "coupon", amount: 0 }]).totalDiscount).toBe(0);
  });
});

describe("promotion engine — enable/disable", () => {
  it("a disabled promotion never applies", () => {
    const config = cfg({ enabled: { ...DEFAULT_PROMOTION_RULES.enabled, ambassador: false } });
    const result = resolvePromotions([{ type: "ambassador", amount: 15 }, { type: "coupon", amount: 10 }], config);
    expect(result.applied).toEqual(["coupon"]);
    expect(result.totalDiscount).toBe(10);
  });
});

describe("promotion engine — stacking toggles", () => {
  it("stacks referral + membership when allowed", () => {
    const config = cfg({ stacking: { ...DEFAULT_PROMOTION_RULES.stacking, referral_membership: true } });
    const result = resolvePromotions([{ type: "referral", amount: 10 }, { type: "member_pricing", amount: 8 }], config);
    expect(result.applied.sort()).toEqual(["member_pricing", "referral"]);
    expect(result.totalDiscount).toBe(18);
  });

  it("stacks Buy3Get1 + ambassador when allowed", () => {
    const config = cfg({ stacking: { ...DEFAULT_PROMOTION_RULES.stacking, buy3get1_ambassador: true } });
    const result = resolvePromotions([{ type: "ambassador", amount: 15 }, { type: "buy3get1", amount: 20 }], config);
    expect(result.totalDiscount).toBe(35);
    expect(result.applied.sort()).toEqual(["ambassador", "buy3get1"]);
  });

  it("does NOT stack Buy3Get1 + ambassador by default (greatest wins)", () => {
    const result = resolvePromotions([{ type: "ambassador", amount: 15 }, { type: "buy3get1", amount: 20 }]);
    expect(result.totalDiscount).toBe(20);
    expect(result.applied).toEqual(["buy3get1"]);
  });
});

describe("promotion engine — priority ordering", () => {
  it("when choose-highest is off, the highest-priority present discount wins", () => {
    const config = cfg({
      chooseHighestAutomatically: false,
      priority: ["coupon", "ambassador", "member_pricing", "referral", "bulk_savings", "buy3get1"],
    });
    const result = resolvePromotions([{ type: "ambassador", amount: 15 }, { type: "coupon", amount: 5 }], config);
    // coupon has higher priority even though ambassador is a bigger discount
    expect(result.applied).toEqual(["coupon"]);
    expect(result.totalDiscount).toBe(5);
  });
});

describe("promotion engine — normalize", () => {
  it("fills missing keys and completes the priority list", () => {
    const norm = normalizePromotionRules({ enabled: { coupon: false } });
    expect(norm.enabled.coupon).toBe(false);
    expect(norm.enabled.ambassador).toBe(true);
    expect(norm.priority).toHaveLength(6);
    expect(new Set(norm.priority).size).toBe(6);
  });
});
