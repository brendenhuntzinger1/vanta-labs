import { DEFAULT_DISCOUNT_PERCENT, DEFAULT_COMMISSION_PERCENT } from "@/lib/referral-config";

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

export function calculateCommissionAmount(total: number, commissionPercent: number = DEFAULT_COMMISSION_PERCENT) {
  return Math.round(total * (commissionPercent / 100) * 100) / 100;
}

