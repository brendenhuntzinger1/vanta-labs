import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { normalizeCouponCode } from "@/lib/coupons";

export type AdminCoupon = {
  id: string;
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  startsAt: string | null;
  endsAt: string | null;
  maxRedemptions: number | null;
  redemptionsCount: number;
  active: boolean;
  createdAt: string;
};

export type CouponInput = {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  startsAt?: string | null;
  endsAt?: string | null;
  maxRedemptions?: number | null;
  active?: boolean;
};

type CouponRow = {
  id: string;
  code: string;
  discount_type: string;
  discount_value: number;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  redemptions_count: number;
  active: boolean;
  created_at: string;
};

function mapCoupon(row: CouponRow): AdminCoupon {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discount_type === "fixed" ? "fixed" : "percent",
    discountValue: Number(row.discount_value ?? 0),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    maxRedemptions: row.max_redemptions,
    redemptionsCount: Number(row.redemptions_count ?? 0),
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function validateCouponInput(input: CouponInput) {
  const code = normalizeCouponCode(input.code);
  if (!code) {
    throw new Error("Coupon code is required");
  }

  if (input.discountType !== "percent" && input.discountType !== "fixed") {
    throw new Error("Discount type must be percent or fixed");
  }

  const discountValue = Number(input.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    throw new Error("Discount value must be a positive number");
  }

  if (input.discountType === "percent" && discountValue > 100) {
    throw new Error("Percent discounts cannot exceed 100");
  }

  if (input.startsAt && input.endsAt && new Date(input.startsAt).getTime() > new Date(input.endsAt).getTime()) {
    throw new Error("Start date must be before end date");
  }

  if (input.maxRedemptions !== undefined && input.maxRedemptions !== null) {
    const maxRedemptions = Number(input.maxRedemptions);
    if (!Number.isFinite(maxRedemptions) || maxRedemptions < 1 || !Number.isInteger(maxRedemptions)) {
      throw new Error("Max redemptions must be a positive whole number");
    }
  }

  return code;
}

export async function listAdminCoupons(): Promise<AdminCoupon[]> {
  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("id, code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => mapCoupon(row as CouponRow));
}

export async function createAdminCoupon(input: CouponInput): Promise<AdminCoupon> {
  const code = validateCouponInput(input);

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .insert({
      code,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      max_redemptions: input.maxRedemptions ?? null,
      active: input.active ?? true,
      redemptions_count: 0,
      created_at: new Date().toISOString(),
    })
    .select("id, code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error(`A coupon with code "${code}" already exists`);
    }
    throw error;
  }

  return mapCoupon(data as CouponRow);
}

export async function updateAdminCoupon(id: string, input: Partial<CouponInput>): Promise<AdminCoupon> {
  const updatePayload: Record<string, unknown> = {};

  if (input.code !== undefined) {
    updatePayload.code = normalizeCouponCode(input.code);
    if (!updatePayload.code) {
      throw new Error("Coupon code is required");
    }
  }

  if (input.discountType !== undefined) {
    if (input.discountType !== "percent" && input.discountType !== "fixed") {
      throw new Error("Discount type must be percent or fixed");
    }
    updatePayload.discount_type = input.discountType;
  }

  if (input.discountValue !== undefined) {
    const discountValue = Number(input.discountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      throw new Error("Discount value must be a positive number");
    }
    updatePayload.discount_value = discountValue;
  }

  if (input.startsAt !== undefined) {
    updatePayload.starts_at = input.startsAt;
  }

  if (input.endsAt !== undefined) {
    updatePayload.ends_at = input.endsAt;
  }

  if (input.maxRedemptions !== undefined) {
    updatePayload.max_redemptions = input.maxRedemptions;
  }

  if (input.active !== undefined) {
    updatePayload.active = input.active;
  }

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .update(updatePayload)
    .eq("id", id)
    .select("id, code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, created_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new Error("A coupon with that code already exists");
    }
    throw error;
  }

  return mapCoupon(data as CouponRow);
}

export async function deleteAdminCoupon(id: string) {
  const { error } = await supabaseAdmin.from("coupons").delete().eq("id", id);
  if (error) {
    throw error;
  }
}
