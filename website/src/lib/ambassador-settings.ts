import { getControlSnapshot, upsertControlValue } from "@/lib/admin-control";
import {
  DEFAULT_COMMISSION_HOLD_DAYS,
  DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
  DEFAULT_MINIMUM_QUALIFYING_ORDER,
} from "@/lib/referral-config";

export interface AmbassadorProgramSettings {
  minimumQualifyingOrder: number;
  minimumPayoutThreshold: number;
  commissionHoldDays: number;
}

const SECTION = "ambassador";

export async function getAmbassadorProgramSettings(): Promise<AmbassadorProgramSettings> {
  try {
    const snapshot = await getControlSnapshot(SECTION);
    const settings = snapshot[SECTION] ?? {};

    const minimumQualifyingOrder = Number(settings.minimum_qualifying_order);
    const minimumPayoutThreshold = Number(settings.minimum_payout_threshold);
    const commissionHoldDays = Number(settings.commission_hold_days ?? process.env.COMMISSION_HOLD_DAYS ?? DEFAULT_COMMISSION_HOLD_DAYS);

    return {
      minimumQualifyingOrder: Number.isFinite(minimumQualifyingOrder) && minimumQualifyingOrder >= 0 ? minimumQualifyingOrder : DEFAULT_MINIMUM_QUALIFYING_ORDER,
      minimumPayoutThreshold: Number.isFinite(minimumPayoutThreshold) && minimumPayoutThreshold >= 0 ? minimumPayoutThreshold : DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
      commissionHoldDays: Number.isFinite(commissionHoldDays) && commissionHoldDays >= 0 ? commissionHoldDays : DEFAULT_COMMISSION_HOLD_DAYS,
    };
  } catch {
    return {
      minimumQualifyingOrder: DEFAULT_MINIMUM_QUALIFYING_ORDER,
      minimumPayoutThreshold: DEFAULT_MINIMUM_PAYOUT_THRESHOLD,
      commissionHoldDays: DEFAULT_COMMISSION_HOLD_DAYS,
    };
  }
}

export async function setAmbassadorProgramSetting(input: {
  key: "minimum_qualifying_order" | "minimum_payout_threshold" | "commission_hold_days";
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
