import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
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

// Flat sales-tax rate (percent) an admin sets in the Control Center. Applied
// to the post-discount merchandise total at checkout. Defaults to 0.
export async function getTaxRatePercent(): Promise<number> {
  try {
    const snapshot = await getControlSnapshot("shipping");
    const value = (snapshot.shipping ?? {}).tax_rate;
    const rate = Number(value ?? 0);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  } catch {
    return 0;
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
    };
  } catch {
    return {};
  }
}