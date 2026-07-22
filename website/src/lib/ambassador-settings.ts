import { getControlSnapshot, upsertControlValue } from "@/lib/admin-control";
import {
  DEFAULT_AMBASSADOR_DISCOUNT_PERCENT,
  DEFAULT_COMMISSION_HOLD_DAYS,
  DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
  DEFAULT_MINIMUM_QUALIFYING_ORDER,
  DEFAULT_STORE_CREDIT_MULTIPLIER_PERCENT,
} from "@/lib/referral-config";

export interface AmbassadorProgramSettings {
  minimumQualifyingOrder: number;
  minimumPayoutThreshold: number;
  commissionHoldDays: number;
  storeCreditMultiplierPercent: number;
  ambassadorDiscountPercent: number;
}

export interface AmbassadorMarketingResource {
  title: string;
  url: string;
  description: string;
}

const SECTION = "ambassador";
const MARKETING_KEY = "marketing_resources";

// Only allow absolute http(s) links (or a same-site /path). Blocks javascript:
// and other schemes so an admin can't store a link that runs script when an
// ambassador clicks it in the portal.
function isSafeResourceUrl(url: string): boolean {
  if (url.startsWith("/")) return true;
  return /^https?:\/\//i.test(url);
}

export async function getAmbassadorMarketingResources(): Promise<AmbassadorMarketingResource[]> {
  try {
    const snapshot = await getControlSnapshot(SECTION);
    const raw = snapshot[SECTION]?.[MARKETING_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        return {
          title: String(record.title ?? "").trim(),
          url: String(record.url ?? "").trim(),
          description: String(record.description ?? "").trim(),
        };
      })
      .filter((item) => item.title && item.url && isSafeResourceUrl(item.url));
  } catch {
    return [];
  }
}

export async function setAmbassadorMarketingResources(input: {
  resources: AmbassadorMarketingResource[];
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const cleaned = (Array.isArray(input.resources) ? input.resources : [])
    .map((item) => ({
      title: String(item?.title ?? "").trim().slice(0, 120),
      url: String(item?.url ?? "").trim().slice(0, 500),
      description: String(item?.description ?? "").trim().slice(0, 400),
    }))
    .filter((item) => item.title && item.url && isSafeResourceUrl(item.url))
    .slice(0, 30);

  await upsertControlValue({
    section: SECTION,
    key: MARKETING_KEY,
    value: cleaned,
    actorUserId: input.actorUserId,
    actorUsername: input.actorUsername,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return cleaned;
}

export async function getAmbassadorProgramSettings(): Promise<AmbassadorProgramSettings> {
  try {
    const snapshot = await getControlSnapshot(SECTION);
    const settings = snapshot[SECTION] ?? {};

    const minimumQualifyingOrder = Number(settings.minimum_qualifying_order);
    const minimumPayoutThreshold = Number(settings.minimum_payout_threshold);
    const commissionHoldDays = Number(settings.commission_hold_days ?? process.env.COMMISSION_HOLD_DAYS ?? DEFAULT_COMMISSION_HOLD_DAYS);
    const storeCreditMultiplierPercent = Number(settings.store_credit_multiplier_percent);
    const ambassadorDiscountPercent = Number(settings.ambassador_discount_percent);

    return {
      minimumQualifyingOrder: Number.isFinite(minimumQualifyingOrder) && minimumQualifyingOrder >= 0 ? minimumQualifyingOrder : DEFAULT_MINIMUM_QUALIFYING_ORDER,
      minimumPayoutThreshold: Number.isFinite(minimumPayoutThreshold) && minimumPayoutThreshold >= 0 ? minimumPayoutThreshold : DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
      commissionHoldDays: Number.isFinite(commissionHoldDays) && commissionHoldDays >= 0 ? commissionHoldDays : DEFAULT_COMMISSION_HOLD_DAYS,
      // Clamp the multiplier to at least 100% so store credit is never worth
      // less than cash (that would make the "bonus" a penalty).
      storeCreditMultiplierPercent: Number.isFinite(storeCreditMultiplierPercent) && storeCreditMultiplierPercent >= 100 ? storeCreditMultiplierPercent : DEFAULT_STORE_CREDIT_MULTIPLIER_PERCENT,
      // 0–100% guard; anything out of range falls back to the default.
      ambassadorDiscountPercent: Number.isFinite(ambassadorDiscountPercent) && ambassadorDiscountPercent >= 0 && ambassadorDiscountPercent <= 100 ? ambassadorDiscountPercent : DEFAULT_AMBASSADOR_DISCOUNT_PERCENT,
    };
  } catch {
    return {
      minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
      minimumPayoutThreshold: DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
      commissionHoldDays: DEFAULT_COMMISSION_HOLD_DAYS,
      storeCreditMultiplierPercent: DEFAULT_STORE_CREDIT_MULTIPLIER_PERCENT,
      ambassadorDiscountPercent: DEFAULT_AMBASSADOR_DISCOUNT_PERCENT,
    };
  }
}

export async function setAmbassadorProgramSetting(input: {
  key:
    | "minimum_qualifying_order"
    | "minimum_payout_threshold"
    | "commission_hold_days"
    | "store_credit_multiplier_percent"
    | "ambassador_discount_percent";
  value: number;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await upsertControlValue({
    section: SECTION,
    key: input.key,
    value: input.value,
    actorUserId: input.actorUserId,
    actorUsername: input.actorUsername,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}
