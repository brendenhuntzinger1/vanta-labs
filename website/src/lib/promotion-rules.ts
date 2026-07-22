import { getControlSnapshot, upsertControlValue } from "@/lib/admin-control";
import {
  DEFAULT_PROMOTION_RULES,
  normalizePromotionRules,
  type PromotionRulesConfig,
} from "@/lib/promotion-engine";

const SECTION = "promotions";
const KEY = "rules";

// Load the admin-configured promotion rules, always returning a complete,
// normalized config (defaults fill any missing keys). Never throws.
export async function getPromotionRules(): Promise<PromotionRulesConfig> {
  try {
    const snapshot = await getControlSnapshot(SECTION);
    const raw = snapshot[SECTION]?.[KEY];
    return normalizePromotionRules(raw ?? DEFAULT_PROMOTION_RULES);
  } catch {
    return DEFAULT_PROMOTION_RULES;
  }
}

export async function setPromotionRules(input: {
  rules: PromotionRulesConfig;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<PromotionRulesConfig> {
  const normalized = normalizePromotionRules(input.rules);
  await upsertControlValue({
    section: SECTION,
    key: KEY,
    value: normalized,
    actorUserId: input.actorUserId,
    actorUsername: input.actorUsername,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
  return normalized;
}
