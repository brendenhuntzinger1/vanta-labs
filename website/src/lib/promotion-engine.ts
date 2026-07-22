// Admin-configurable promotion stacking engine, shared by the server checkout
// (payment-service.ts) and the client preview (cart-context.tsx) so both always
// agree. With the DEFAULT config it reproduces the historical behavior exactly:
// only one percentage discount applies, greatest savings wins, and Buy-3-Get-1
// competes as a single candidate. Toggles then allow specific combinations to
// stack, without any code change.

export type PromotionType =
  | "bulk_savings"
  | "buy3get1"
  | "referral"
  | "coupon"
  | "member_pricing"
  | "ambassador";

export interface PromotionCandidate {
  type: PromotionType;
  amount: number;
}

export interface PromotionRulesConfig {
  // When true (default), the single greatest discount wins ties/among competing
  // promotions. When false, the promotion highest in `priority` wins instead.
  chooseHighestAutomatically: boolean;
  // Per-promotion master switch. A disabled promotion never applies.
  enabled: Record<PromotionType, boolean>;
  // Specific pairs allowed to STACK (add together). All off by default.
  stacking: {
    buy3get1_ambassador: boolean;
    buy3get1_membership: boolean;
    referral_membership: boolean;
    coupon_promotions: boolean; // coupon + Buy-3-Get-1
  };
  // Tie-break / priority order (earlier = higher priority).
  priority: PromotionType[];
}

export interface PromotionResult {
  totalDiscount: number;
  applied: PromotionType[];
}

export const DEFAULT_PROMOTION_PRIORITY: PromotionType[] = [
  "referral",
  "ambassador",
  "member_pricing",
  "bulk_savings",
  "coupon",
  "buy3get1",
];

export const DEFAULT_PROMOTION_RULES: PromotionRulesConfig = {
  chooseHighestAutomatically: true,
  enabled: {
    bulk_savings: true,
    buy3get1: true,
    referral: true,
    coupon: true,
    member_pricing: true,
    ambassador: true,
  },
  stacking: {
    buy3get1_ambassador: false,
    buy3get1_membership: false,
    referral_membership: false,
    coupon_promotions: false,
  },
  priority: DEFAULT_PROMOTION_PRIORITY,
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function priorityIndex(config: PromotionRulesConfig, type: PromotionType): number {
  const idx = config.priority.indexOf(type);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

// Merge a possibly-partial stored config with the defaults so missing keys are
// always safe.
export function normalizePromotionRules(raw: unknown): PromotionRulesConfig {
  const source = (raw ?? {}) as Partial<PromotionRulesConfig>;
  const enabled = { ...DEFAULT_PROMOTION_RULES.enabled, ...(source.enabled ?? {}) };
  const stacking = { ...DEFAULT_PROMOTION_RULES.stacking, ...(source.stacking ?? {}) };
  const priority = Array.isArray(source.priority) && source.priority.length > 0
    ? (source.priority.filter((t): t is PromotionType => DEFAULT_PROMOTION_PRIORITY.includes(t as PromotionType)))
    : DEFAULT_PROMOTION_RULES.priority;
  // Ensure every type appears exactly once in priority.
  const fullPriority = [...priority, ...DEFAULT_PROMOTION_PRIORITY.filter((t) => !priority.includes(t))];
  return {
    chooseHighestAutomatically: source.chooseHighestAutomatically ?? true,
    enabled,
    stacking,
    priority: fullPriority,
  };
}

// Resolve the total discount and which promotions applied, honoring enable
// switches, greatest-vs-priority selection, and the stacking toggles.
export function resolvePromotions(
  candidates: PromotionCandidate[],
  config: PromotionRulesConfig = DEFAULT_PROMOTION_RULES,
): PromotionResult {
  const active = candidates.filter((c) => c.amount > 0 && config.enabled[c.type] !== false);
  if (active.length === 0) return { totalDiscount: 0, applied: [] };

  const amountByType = new Map<PromotionType, number>();
  for (const c of active) amountByType.set(c.type, (amountByType.get(c.type) ?? 0) + c.amount);

  const promo = amountByType.get("buy3get1") ?? 0;
  const percents = active.filter((c) => c.type !== "buy3get1");

  // Choose the base percentage discount: greatest amount, or by priority when
  // "choose highest automatically" is off. Ties always break by priority.
  let baseType: PromotionType | null = null;
  let baseAmount = 0;
  if (percents.length > 0) {
    const sorted = [...percents].sort((a, b) => {
      if (config.chooseHighestAutomatically && b.amount !== a.amount) return b.amount - a.amount;
      return priorityIndex(config, a.type) - priorityIndex(config, b.type);
    });
    baseType = sorted[0].type;
    baseAmount = amountByType.get(baseType) ?? sorted[0].amount;
  }

  const applied: PromotionType[] = [];
  let total = 0;
  if (baseType) {
    applied.push(baseType);
    total += baseAmount;
  }

  // Stack a second percentage discount when referral + membership is allowed.
  if (config.stacking.referral_membership) {
    if (baseType === "referral" && amountByType.has("member_pricing")) {
      applied.push("member_pricing");
      total += amountByType.get("member_pricing") ?? 0;
    } else if (baseType === "member_pricing" && amountByType.has("referral")) {
      applied.push("referral");
      total += amountByType.get("referral") ?? 0;
    }
  }

  // Buy-3-Get-1 (a free-item promo) either stacks with the base discount when
  // its toggle is on, or competes as a single candidate (greatest wins).
  if (promo > 0) {
    const stacksWithBase =
      baseType === null ||
      (baseType === "ambassador" && config.stacking.buy3get1_ambassador) ||
      (baseType === "member_pricing" && config.stacking.buy3get1_membership) ||
      (baseType === "coupon" && config.stacking.coupon_promotions);
    if (stacksWithBase) {
      applied.push("buy3get1");
      total += promo;
    } else if (promo > total) {
      return { totalDiscount: round(promo), applied: ["buy3get1"] };
    }
  }

  return { totalDiscount: round(total), applied };
}
