import { DEFAULT_DISCOUNT_PERCENT } from "@/lib/referral-config";

export interface ReferralRecord {
  id: string;
  referral_code: string;
  ambassador_id: string;
  ambassador_name: string;
  commission_percent: number;
  status: string;
}

export interface ReferralValidationResult {
  referralCode: string;
  ambassadorId: string;
  ambassadorName: string;
  commissionPercent: number;
  discountPercent: number;
}

export function normalizeReferralCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

export function calculateDiscountAmount(subtotal: number, discountPercent: number = DEFAULT_DISCOUNT_PERCENT) {
  return Math.round(subtotal * (discountPercent / 100) * 100) / 100;
}

// The percent is REQUIRED. It used to default to a DEFAULT_COMMISSION_PERCENT
// of 15, which contradicted the real default the store pays (10, from the
// Control Center via admin-control). Nothing in production ever hit that
// default, so it was not a live defect — it was a trap waiting for the first
// caller who omitted the argument.
export function calculateCommissionAmount(total: number, commissionPercent: number) {
  return Math.round(total * (commissionPercent / 100) * 100) / 100;
}

