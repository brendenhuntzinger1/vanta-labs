import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
import { DEFAULT_SHIPPING_CONFIG, type ShippingConfig } from "@/lib/shipping";
import { resolveBundleConfig, type BundleConfig } from "@/lib/bundle-pricing";
import {
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_CARD_PROCESSING_FEE,
  type PaymentMethodConfig,
  type CardProcessingFeeConfig,
} from "@/lib/payment-methods";

const CONTROL_ACTION = "admin_control_upsert";

type ControlRow = {
  id: string;
  target_table: string | null;
  target_id: string | null;
  metadata: { value?: unknown } | null;
  created_at: string;
};

export type HomepageControlConfig = {
  promoTickerItems?: string[];
  heroKicker?: string;
  heroHeadline?: string;
  heroSubheadline?: string;
  promoPills?: string[];
  promoCaption?: string;
  featuredProductSlugs?: string[];
  qualityPanelTitle?: string;
  qualityPanelItems?: string[];
  promoBuy3Get1Enabled?: boolean;
  promoBuy2Get1HalfEnabled?: boolean;
  bundleConfig?: BundleConfig;
};

function sanitizeSection(section: string) {
  return section.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeKey(key: string) {
  return key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export async function getControlSnapshot(section?: string) {
  const normalizedSection = section ? sanitizeSection(section) : null;

  let query = supabaseAdmin
    .from("admin_audit_logs")
    .select("id, target_table, target_id, metadata, created_at")
    .eq("action", CONTROL_ACTION)
    .order("created_at", { ascending: false })
    .limit(1500);

  if (normalizedSection) {
    query = query.eq("target_table", normalizedSection);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as ControlRow[];
  const result: Record<string, Record<string, unknown>> = {};

  for (const row of rows) {
    const table = sanitizeSection(String(row.target_table ?? ""));
    const key = sanitizeKey(String(row.target_id ?? ""));
    if (!table || !key) {
      continue;
    }

    result[table] ??= {};
    if (!(key in result[table])) {
      result[table][key] = row.metadata?.value ?? null;
    }
  }

  return result;
}

export async function upsertControlValue(input: {
  section: string;
  key: string;
  value: unknown;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const section = sanitizeSection(input.section);
  const key = sanitizeKey(input.key);
  if (!section || !key) {
    throw new Error("Section and key are required");
  }

  const { error } = await supabaseAdmin
    .from("admin_audit_logs")
    .insert({
      actor_user_id: input.actorUserId ?? null,
      action: CONTROL_ACTION,
      target_table: section,
      target_id: key,
      metadata: {
        value: input.value,
        actorUsername: input.actorUsername ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      created_at: new Date().toISOString(),
    });

  if (error) {
    throw error;
  }
}

export async function getBulkSavingsControlConfig(): Promise<BulkSavingsConfig> {
  try {
    const snapshot = await getControlSnapshot("bulk_savings");
    const config = snapshot.bulk_savings ?? {};
    return {
      enabled: config.enabled !== false,
      tier1Threshold: Number(config.tier1_threshold ?? DEFAULT_BULK_SAVINGS_CONFIG.tier1Threshold),
      tier1Percent: Number(config.tier1_percent ?? DEFAULT_BULK_SAVINGS_CONFIG.tier1Percent),
      tier2Threshold: Number(config.tier2_threshold ?? DEFAULT_BULK_SAVINGS_CONFIG.tier2Threshold),
      tier2Percent: Number(config.tier2_percent ?? DEFAULT_BULK_SAVINGS_CONFIG.tier2Percent),
    };
  } catch {
    return DEFAULT_BULK_SAVINGS_CONFIG;
  }
}

export async function setBulkSavingsControlValue(input: {
  key: "enabled" | "tier1_threshold" | "tier1_percent" | "tier2_threshold" | "tier2_percent";
  value: unknown;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await upsertControlValue({ section: "bulk_savings", ...input });
}

export interface CartRecoveryConfig {
  t30mEnabled: boolean;
  t12hEnabled: boolean;
  t24hEnabled: boolean;
  t72hEnabled: boolean;
  discountPercent: number;
  couponExpirationHours: number;
}

export const DEFAULT_CART_RECOVERY_CONFIG: CartRecoveryConfig = {
  t30mEnabled: true,
  t12hEnabled: true,
  t24hEnabled: true,
  t72hEnabled: true,
  discountPercent: 5,
  couponExpirationHours: 48,
};

export async function getCartRecoveryControlConfig(): Promise<CartRecoveryConfig> {
  try {
    const snapshot = await getControlSnapshot("cart_recovery");
    const config = snapshot.cart_recovery ?? {};
    return {
      t30mEnabled: config.t30m_enabled !== false,
      t12hEnabled: config.t12h_enabled !== false,
      t24hEnabled: config.t24h_enabled !== false,
      t72hEnabled: config.t72h_enabled !== false,
      discountPercent: Number(config.discount_percent ?? DEFAULT_CART_RECOVERY_CONFIG.discountPercent),
      couponExpirationHours: Number(config.coupon_expiration_hours ?? DEFAULT_CART_RECOVERY_CONFIG.couponExpirationHours),
    };
  } catch {
    return DEFAULT_CART_RECOVERY_CONFIG;
  }
}

// -------------------------------------------------------------------------
// Payment methods (Cash App / Zelle / PayPal / Card / future) + the card
// processing fee.
//
// The code defaults in src/lib/payment-methods.ts are the placeholder base.
// Admins can override any field per method at runtime - stored in the
// "payment_methods" control section, keyed by method id, with a partial
// PaymentMethodConfig as the value. The card processing fee lives under the
// "card_processing_fee" key of the same section. This lets you tune the fee
// and account details without a deploy while keeping the code file as the
// fallback.
// -------------------------------------------------------------------------
function mergePaymentMethod(base: PaymentMethodConfig, override: unknown): PaymentMethodConfig {
  if (!override || typeof override !== "object") {
    return base;
  }
  const o = override as Record<string, unknown>;
  const str = (key: keyof PaymentMethodConfig) =>
    typeof o[key] === "string" ? (o[key] as string) : (base[key] as string | undefined);

  return {
    ...base,
    label: typeof o.label === "string" ? o.label : base.label,
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    order: o.order !== undefined ? Number(o.order) || base.order : base.order,
    icon: typeof o.icon === "string" ? o.icon : base.icon,
    recommended: typeof o.recommended === "boolean" ? o.recommended : base.recommended,
    badges: Array.isArray(o.badges) ? (o.badges as unknown[]).map((b) => String(b)) : base.badges,
    description: str("description"),
    tagline: str("tagline"),
    handle: str("handle"),
    businessName: str("businessName"),
    email: str("email"),
    phone: str("phone"),
    qrImageUrl: str("qrImageUrl"),
    instructions: Array.isArray(o.instructions)
      ? (o.instructions as unknown[]).map((line) => String(line))
      : base.instructions,
    memoNote: str("memoNote"),
    referenceLabel: str("referenceLabel"),
  };
}

export async function getPaymentMethodsConfig(): Promise<PaymentMethodConfig[]> {
  try {
    const snapshot = await getControlSnapshot("payment_methods");
    const overrides = snapshot.payment_methods ?? {};
    return DEFAULT_PAYMENT_METHODS.map((method) => mergePaymentMethod(method, overrides[method.id]));
  } catch {
    return DEFAULT_PAYMENT_METHODS;
  }
}

export async function getCardProcessingFeeConfig(): Promise<CardProcessingFeeConfig> {
  try {
    const snapshot = await getControlSnapshot("payment_methods");
    const override = (snapshot.payment_methods ?? {}).card_processing_fee;
    if (!override || typeof override !== "object") {
      return DEFAULT_CARD_PROCESSING_FEE;
    }
    const o = override as Record<string, unknown>;
    return {
      enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_CARD_PROCESSING_FEE.enabled,
      percentage: o.percentage !== undefined ? Number(o.percentage) || 0 : DEFAULT_CARD_PROCESSING_FEE.percentage,
      label: typeof o.label === "string" ? o.label : DEFAULT_CARD_PROCESSING_FEE.label,
      noticeText: typeof o.noticeText === "string" ? o.noticeText : DEFAULT_CARD_PROCESSING_FEE.noticeText,
    };
  } catch {
    return DEFAULT_CARD_PROCESSING_FEE;
  }
}

export async function setPaymentMethodControlValue(input: {
  methodId: string;
  value: Partial<PaymentMethodConfig> | Partial<CardProcessingFeeConfig>;
  actorUserId?: string | null;
  actorUsername?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  await upsertControlValue({
    section: "payment_methods",
    key: input.methodId,
    value: input.value,
    actorUserId: input.actorUserId,
    actorUsername: input.actorUsername,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}

// Business identity used for outbound support/notification email. Editable in
// Admin → Settings; defaults below.
export interface BusinessSettings {
  supportEmail: string;
  businessName: string;
}

export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  supportEmail: "brendenhuntzinger1@vantalabsresearch.com",
  businessName: "Vanta Labs",
};

export async function getBusinessSettings(): Promise<BusinessSettings> {
  try {
    const snapshot = await getControlSnapshot("business");
    const cfg = snapshot.business ?? {};
    return {
      supportEmail: (typeof cfg.support_email === "string" && cfg.support_email.trim()) || DEFAULT_BUSINESS_SETTINGS.supportEmail,
      businessName: (typeof cfg.business_name === "string" && cfg.business_name.trim()) || DEFAULT_BUSINESS_SETTINGS.businessName,
    };
  } catch {
    return DEFAULT_BUSINESS_SETTINGS;
  }
}

// Subscribe & Save — a recurring-order option that customers can opt into.
// DORMANT until a recurring payment processor is connected: opt-ins are stored
// as pending subscriptions and never charged without a processor.
export interface SubscribeSaveConfig {
  enabled: boolean;
  discountPercent: number;
  frequencyDays: number;
  headline: string;
}

export const DEFAULT_SUBSCRIBE_SAVE: SubscribeSaveConfig = {
  enabled: false,
  discountPercent: 10,
  frequencyDays: 30,
  headline: "Subscribe & Save",
};

export async function getSubscribeSaveConfig(): Promise<SubscribeSaveConfig> {
  try {
    const snapshot = await getControlSnapshot("subscribe_save");
    const cfg = snapshot.subscribe_save ?? {};
    return {
      enabled: cfg.enabled === true,
      discountPercent: Number(cfg.discount_percent ?? DEFAULT_SUBSCRIBE_SAVE.discountPercent) || DEFAULT_SUBSCRIBE_SAVE.discountPercent,
      frequencyDays: Number(cfg.frequency_days ?? DEFAULT_SUBSCRIBE_SAVE.frequencyDays) || DEFAULT_SUBSCRIBE_SAVE.frequencyDays,
      headline: (typeof cfg.headline === "string" && cfg.headline.trim()) || DEFAULT_SUBSCRIBE_SAVE.headline,
    };
  } catch {
    return DEFAULT_SUBSCRIBE_SAVE;
  }
}

// First-order welcome offer — a promo code shown in a banner to new visitors.
// Works as a "virtual coupon" (no DB row needed): validateCoupon honors the
// configured code when the offer is enabled. Off by default.
export interface WelcomeOffer {
  enabled: boolean;
  code: string;
  percent: number;
  headline: string;
  subtext: string;
}

export const DEFAULT_WELCOME_OFFER: WelcomeOffer = {
  enabled: false,
  code: "WELCOME10",
  percent: 10,
  headline: "Get 10% off your first order",
  subtext: "New here? Use this code at checkout.",
};

export async function getWelcomeOffer(): Promise<WelcomeOffer> {
  try {
    const snapshot = await getControlSnapshot("welcome_offer");
    const cfg = snapshot.welcome_offer ?? {};
    return {
      enabled: cfg.enabled === true,
      code: (typeof cfg.code === "string" && cfg.code.trim().toUpperCase()) || DEFAULT_WELCOME_OFFER.code,
      percent: Number(cfg.percent ?? DEFAULT_WELCOME_OFFER.percent) || DEFAULT_WELCOME_OFFER.percent,
      headline: (typeof cfg.headline === "string" && cfg.headline.trim()) || DEFAULT_WELCOME_OFFER.headline,
      subtext: (typeof cfg.subtext === "string" && cfg.subtext.trim()) || DEFAULT_WELCOME_OFFER.subtext,
    };
  } catch {
    return DEFAULT_WELCOME_OFFER;
  }
}

// Default sales-tax rate applied when an admin hasn't set one. Editable in the
// Control Center → Shipping (enter 0 to collect no sales tax).
export const DEFAULT_SALES_TAX_PERCENT = 7;
// Default customer discount for a valid ambassador referral code.
export const DEFAULT_REFERRAL_DISCOUNT_PERCENT = 10;
// Reduced referral discount that STACKS on top of a bundle (Buy 3 Get 1) order.
export const DEFAULT_BUNDLE_REFERRAL_DISCOUNT_PERCENT = 5;
// Default personal discount an approved ambassador gets on their OWN purchases.
export const DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT = 10;
// Default commission rate when an ambassador has no explicit rate set.
export const DEFAULT_AMBASSADOR_COMMISSION_PERCENT = 10;

// Flat sales-tax rate (percent) an admin sets in the Control Center. Applied to
// the post-discount merchandise total at checkout. Unset falls back to
// DEFAULT_SALES_TAX_PERCENT; an explicit "0" turns sales tax off.
export async function getTaxRatePercent(): Promise<number> {
  try {
    const snapshot = await getControlSnapshot("shipping");
    const value = (snapshot.shipping ?? {}).tax_rate;
    if (value === "" || value == null) {
      return DEFAULT_SALES_TAX_PERCENT;
    }
    const rate = Number(value);
    return Number.isFinite(rate) && rate >= 0 ? rate : DEFAULT_SALES_TAX_PERCENT;
  } catch {
    return DEFAULT_SALES_TAX_PERCENT;
  }
}

export interface ReferralProgramConfig {
  // Master on/off for the ambassador referral program. When off, referral codes
  // are rejected at checkout and no new commissions accrue.
  enabled: boolean;
  // Customer discount a valid referral code applies (percent).
  discountPercent: number;
  // Reduced referral discount that stacks on a bundle (Buy 3 Get 1) order.
  bundleReferralPercent: number;
  // Personal discount an approved ambassador gets on their OWN purchases.
  personalDiscountPercent: number;
  // Default commission rate used when an ambassador has no explicit rate.
  defaultCommissionPercent: number;
  // When true, referral attribution still happens but NO new commission accrues
  // (a global pause the admin can toggle without disabling every ambassador).
  commissionsPaused: boolean;
}

function clampPercent(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

// Ambassador/referral program controls (Control Center → Referral Program).
// Defaults keep the program ON with a 10% customer discount, a 10% personal
// ambassador discount, a 10% default commission, and commissions running.
export async function getReferralProgramConfig(): Promise<ReferralProgramConfig> {
  const fallback: ReferralProgramConfig = {
    enabled: true,
    discountPercent: DEFAULT_REFERRAL_DISCOUNT_PERCENT,
    bundleReferralPercent: DEFAULT_BUNDLE_REFERRAL_DISCOUNT_PERCENT,
    personalDiscountPercent: DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT,
    defaultCommissionPercent: DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
    commissionsPaused: false,
  };
  try {
    const snapshot = await getControlSnapshot("referral");
    const referral = snapshot.referral ?? {};
    return {
      enabled: referral.enabled !== false,
      discountPercent: clampPercent(referral.discount_percent, DEFAULT_REFERRAL_DISCOUNT_PERCENT),
      bundleReferralPercent: clampPercent(referral.bundle_referral_percent, DEFAULT_BUNDLE_REFERRAL_DISCOUNT_PERCENT),
      personalDiscountPercent: clampPercent(referral.personal_discount_percent, DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT),
      defaultCommissionPercent: clampPercent(referral.default_commission_percent, DEFAULT_AMBASSADOR_COMMISSION_PERCENT),
      commissionsPaused: referral.commissions_paused === true,
    };
  } catch {
    return fallback;
  }
}

// Store-wide profit-protection defaults (Control Center → Profit Protection).
// The engine (src/lib/profit-engine.ts) uses these to guarantee no order
// finalizes below the floor. All editable live; sensible defaults keep the
// guard active before an admin ever touches them.
export interface ProfitSettingsConfig {
  minProfitPercent: number;
  minProfitDollars: number;
  worstCaseUnitCost: number;
  processingFeePercent: number;
}

// Default: never sell at a loss (profit >= $0). Raise the minimums in the
// Control Center to require a margin buffer beyond break-even.
export const DEFAULT_PROFIT_CONFIG: ProfitSettingsConfig = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: 10,
};

export async function getProfitSettings(): Promise<ProfitSettingsConfig> {
  try {
    const snapshot = await getControlSnapshot("profit");
    const profit = snapshot.profit ?? {};
    const num = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      minProfitPercent: num(profit.min_profit_percent, DEFAULT_PROFIT_CONFIG.minProfitPercent),
      minProfitDollars: num(profit.min_profit_dollars, DEFAULT_PROFIT_CONFIG.minProfitDollars),
      worstCaseUnitCost: num(profit.worst_case_unit_cost, DEFAULT_PROFIT_CONFIG.worstCaseUnitCost),
      processingFeePercent: num(profit.processing_fee_percent, DEFAULT_PROFIT_CONFIG.processingFeePercent),
    };
  } catch {
    return DEFAULT_PROFIT_CONFIG;
  }
}

export interface CouponPolicyConfig {
  // Master on/off for site coupon codes.
  couponsEnabled: boolean;
  // When true, a coupon may combine with an ambassador referral code. Default
  // OFF: coupons and referral codes never stack (spec).
  allowStacking: boolean;
}

// Coupon policy controls (Control Center → Coupons). Defaults keep coupons ON
// and stacking OFF, matching prior behavior.
export async function getCouponPolicyConfig(): Promise<CouponPolicyConfig> {
  try {
    const snapshot = await getControlSnapshot("coupons");
    const coupons = snapshot.coupons ?? {};
    return {
      couponsEnabled: coupons.enabled !== false,
      allowStacking: coupons.allow_stacking === true,
    };
  } catch {
    return { couponsEnabled: true, allowStacking: false };
  }
}

// Admin-editable shipping + service-fee config (Control Center → Shipping).
// A blank/invalid field falls back to the coded default in shipping.ts, so the
// checkout math keeps working before an admin ever touches these. The domestic
// flat rate + free-shipping threshold and the service-fee percent are exposed
// in the Control Center; international rates keep their defaults.
export async function getShippingConfig(): Promise<ShippingConfig> {
  try {
    const snapshot = await getControlSnapshot("shipping");
    const shipping = snapshot.shipping ?? {};

    const num = (value: unknown, fallback: number): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };

    // Service fee is entered as a percent (e.g. "5" = 5%); stored blank keeps
    // the default 5%. Enter "0" to turn the service fee off entirely.
    const rawServiceFee = shipping.service_fee;
    const serviceFeePercent =
      rawServiceFee === "" || rawServiceFee == null
        ? DEFAULT_SHIPPING_CONFIG.handlingFeeRate * 100
        : num(rawServiceFee, DEFAULT_SHIPPING_CONFIG.handlingFeeRate * 100);

    return {
      domesticFee: num(shipping.flat_rate, DEFAULT_SHIPPING_CONFIG.domesticFee),
      freeShippingThreshold: num(shipping.free_shipping_threshold, DEFAULT_SHIPPING_CONFIG.freeShippingThreshold),
      internationalFee: num(shipping.international_flat_rate, DEFAULT_SHIPPING_CONFIG.internationalFee),
      internationalFreeShippingThreshold: num(shipping.international_free_shipping_threshold, DEFAULT_SHIPPING_CONFIG.internationalFreeShippingThreshold),
      handlingFeeRate: Math.max(0, serviceFeePercent) / 100,
    };
  } catch {
    return DEFAULT_SHIPPING_CONFIG;
  }
}

export async function getHomepageControlConfig(): Promise<HomepageControlConfig> {
  try {
    const snapshot = await getControlSnapshot();
    const homepage = snapshot.homepage ?? {};
    const promotions = snapshot.promotions ?? {};
    return {
      promoTickerItems: Array.isArray(homepage.promo_ticker_items) ? homepage.promo_ticker_items as string[] : undefined,
      heroKicker: typeof homepage.hero_kicker === "string" ? homepage.hero_kicker : undefined,
      heroHeadline: typeof homepage.hero_headline === "string" ? homepage.hero_headline : undefined,
      heroSubheadline: typeof homepage.hero_subheadline === "string" ? homepage.hero_subheadline : undefined,
      promoPills: Array.isArray(homepage.promo_pills) ? homepage.promo_pills as string[] : undefined,
      promoCaption: typeof homepage.promo_caption === "string" ? homepage.promo_caption : undefined,
      featuredProductSlugs: Array.isArray(homepage.featured_product_slugs) ? homepage.featured_product_slugs as string[] : undefined,
      qualityPanelTitle: typeof homepage.quality_panel_title === "string" ? homepage.quality_panel_title : undefined,
      qualityPanelItems: Array.isArray(homepage.quality_panel_items) ? homepage.quality_panel_items as string[] : undefined,
      promoBuy3Get1Enabled: Boolean(promotions.buy_3_get_1_enabled ?? false),
      promoBuy2Get1HalfEnabled: Boolean(promotions.buy_2_get_1_half_enabled ?? false),
      bundleConfig: resolveBundleConfig({
        twoUnitPercent: promotions.bundle_two_unit_percent,
        threePlusPercent: promotions.bundle_three_plus_percent,
      }),
    };
  } catch {
    return {};
  }
}