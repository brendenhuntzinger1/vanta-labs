import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
import { DEFAULT_SHIPPING_CONFIG, type ShippingConfig } from "@/lib/shipping";
import { DEFAULT_SALES_TAX_CONFIG, normalizeUsState, type SalesTaxConfig } from "@/lib/sales-tax";
import { resolveBundleConfig, type BundleConfig } from "@/lib/bundle-pricing";
import {
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_CARD_PROCESSING_FEE,
  type PaymentMethodConfig,
  type CardProcessingFeeConfig,
} from "@/lib/payment-methods";
import { PROCESSING_FEE_DEFAULT_PERCENT, describeEffectiveRate, parseRatePercent } from "@/lib/admin-control-shared";

// Re-exported so every existing/expected `@/lib/admin-control` import site
// keeps working. The implementation itself lives in admin-control-shared.ts
// (which has no `server-only` import) because this file's `import
// "server-only"` above poisons the whole module for any Client Component
// that imports from it — Next.js hard-errors at build time even for an
// otherwise-pure, dependency-free export like this one. A Client Component
// (e.g. admin-control-center-client.tsx) must import `describeEffectiveRate`
// from `@/lib/admin-control-shared` directly, not from here.
export { describeEffectiveRate, parseRatePercent };

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
  /**
   * When true, quantity "Bundle & Save" pricing stacks with the winning
   * percentage discount (legacy behavior). Default FALSE: bundle pricing
   * competes like every other discount — one discount per order, best wins.
   */
  bundleStacking?: boolean;
};

function sanitizeSection(section: string) {
  return section.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeKey(key: string) {
  return key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * The database view that resolves the newest write per (section, key).
 *
 * Settings are stored append-only — every save INSERTs a row — so "the current
 * value" is "the newest row for this key". Expressing that in PostgREST is not
 * possible, so this reader used to approximate it: take the newest 1500 rows
 * and keep the first occurrence of each key. That is correct only while the
 * whole history fits in the window; past it, a key nobody has touched recently
 * drops out and reads as ABSENT, which every caller turns into "use the code
 * default". Reproduced: 1600 later writes made a stored `referral` section
 * vanish from the unscoped snapshot while the value was really set.
 *
 * `admin_control_current` does the DISTINCT ON in the database, so the result
 * is bounded by the number of distinct SETTINGS rather than by the number of
 * historical WRITES, and no amount of history can hide a current value.
 */
const CONTROL_VIEW = "admin_control_current";

/**
 * The window the pre-view reader used, kept for the fallback below.
 *
 * Deliberately unchanged rather than raised: a bigger arbitrary number moves
 * the cliff without removing it, and the view removes it.
 */
const CONTROL_HISTORY_WINDOW = 1500;

/**
 * True once the deployment is reading current values from the view.
 *
 * Surfaced on /admin/status so a database that has not had
 * admin-control-current-view.sql applied is visible rather than silently
 * running on the old approximation.
 */
export async function isControlCurrentViewAvailable(): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from(CONTROL_VIEW).select("target_table").limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function readControlRows(normalizedSection: string | null): Promise<ControlRow[]> {
  // Preferred path: one row per key, straight from the view.
  try {
    let viewQuery = supabaseAdmin
      .from(CONTROL_VIEW)
      .select("id, target_table, target_id, metadata, created_at");
    if (normalizedSection) {
      viewQuery = viewQuery.eq("target_table", normalizedSection);
    }
    const { data, error } = await viewQuery;
    // An EMPTY result is treated as inconclusive rather than as "no settings":
    // a database without the view answers with an error, but a caller that has
    // stubbed the client may simply answer with nothing, and reading that as
    // "nothing is configured" would wipe the snapshot. Falling through costs
    // one extra query only when there is genuinely nothing to read.
    if (!error && data && data.length > 0) {
      return data as ControlRow[];
    }
  } catch {
    // Fall through — the view is optional at deploy time.
  }

  // Fallback for a database where the view has not been created yet. Identical
  // to the historical behaviour, so deploying the code before the migration
  // changes nothing; /admin/status reports that this path is in use.
  let query = supabaseAdmin
    .from("admin_audit_logs")
    .select("id, target_table, target_id, metadata, created_at")
    .eq("action", CONTROL_ACTION)
    .order("created_at", { ascending: false })
    .limit(CONTROL_HISTORY_WINDOW);

  if (normalizedSection) {
    query = query.eq("target_table", normalizedSection);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }
  return (data ?? []) as ControlRow[];
}

export async function getControlSnapshot(section?: string) {
  const normalizedSection = section ? sanitizeSection(section) : null;

  // Newest-first, so "first occurrence of a key wins" resolves the current
  // value on BOTH paths. The view already returns one row per key; the
  // fallback returns history and relies on the ordering.
  const rows = await readControlRows(normalizedSection);
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
    // Blank = default (Number("") is 0 — a blank tier threshold must not
    // unlock bulk savings at $0).
    const num = (value: unknown, fallback: number) => {
      if (value === "" || value == null) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      enabled: config.enabled !== false,
      tier1Threshold: num(config.tier1_threshold, DEFAULT_BULK_SAVINGS_CONFIG.tier1Threshold),
      tier1Percent: num(config.tier1_percent, DEFAULT_BULK_SAVINGS_CONFIG.tier1Percent),
      tier2Threshold: num(config.tier2_threshold, DEFAULT_BULK_SAVINGS_CONFIG.tier2Threshold),
      tier2Percent: num(config.tier2_percent, DEFAULT_BULK_SAVINGS_CONFIG.tier2Percent),
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
  supportEmail: "support@vantalabsresearch.com",
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
// ——— Sales tax (dynamic, address-based) ————————————————————————————————
// The old storewide flat rate (shipping.tax_rate, default 8%) is GONE. Tax is
// now resolved per order from the shipping address by src/lib/sales-tax.ts:
// collected only for states in the admin-configured nexus list, at each
// state's combined average rate (override-able per state below).

export type SalesTaxProviderName = "builtin" | "taxjar" | "avalara";

export interface SalesTaxSettings extends SalesTaxConfig {
  // Which rate source computes quotes. "builtin" is the bundled state-level
  // resolver; "taxjar" / "avalara" are reserved for the live-rate integration
  // (see tax-provider.ts) and fall back to builtin until wired + configured.
  provider: SalesTaxProviderName;
  // Stored credentials for the future provider integration (never sent to the
  // client; only *ApiKeySet booleans surface in the admin UI).
  taxjarApiKey: string;
  avalaraLicenseKey: string;
}
// Default customer discount for a valid ambassador referral code.
export const DEFAULT_REFERRAL_DISCOUNT_PERCENT = 10;
// Default personal discount an approved ambassador gets on their OWN purchases.
// Deliberately HIGHER than the 10% customer/referral discount above: this is
// the ambassador's own benefit, not their audience's, and the two rates are
// independent by design. Raising it does not change what a referred customer
// pays and does not change commission.
export const DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT = 20;
// Starting commission rate for a new ambassador when no explicit per-ambassador
// rate is set. Admins can raise (or lock) any individual ambassador's rate in
// Admin → Partners.
export const DEFAULT_AMBASSADOR_COMMISSION_PERCENT = 10;

// Reads the "tax" control section. Defaults are deliberately conservative:
// with no nexus states configured, NO tax is collected anywhere — a store
// must never collect tax it isn't registered to remit. (The legacy flat
// shipping.tax_rate value is intentionally ignored.)
export async function getSalesTaxSettings(): Promise<SalesTaxSettings> {
  const defaults: SalesTaxSettings = {
    ...DEFAULT_SALES_TAX_CONFIG,
    provider: "builtin",
    taxjarApiKey: "",
    avalaraLicenseKey: "",
  };
  try {
    const snapshot = await getControlSnapshot("tax");
    const section = snapshot.tax ?? {};

    const nexusStates = String(section.nexus_states ?? "")
      .split(",")
      .map((s) => normalizeUsState(s))
      .filter((s): s is string => Boolean(s));

    let rateOverrides: Record<string, number> = {};
    try {
      const parsed = JSON.parse(String(section.rate_overrides ?? "{}"));
      if (parsed && typeof parsed === "object") {
        for (const [state, rate] of Object.entries(parsed)) {
          const code = normalizeUsState(state);
          const value = Number(rate);
          if (code && Number.isFinite(value) && value >= 0 && value <= 25) {
            rateOverrides[code] = value;
          }
        }
      }
    } catch {
      rateOverrides = {};
    }

    const providerRaw = String(section.provider ?? "builtin").trim().toLowerCase();
    const provider: SalesTaxProviderName =
      providerRaw === "taxjar" || providerRaw === "avalara" ? providerRaw : "builtin";

    return {
      nexusStates: Array.from(new Set(nexusStates)),
      rateOverrides,
      provider,
      taxjarApiKey: String(section.taxjar_api_key ?? ""),
      avalaraLicenseKey: String(section.avalara_license_key ?? ""),
    };
  } catch {
    return defaults;
  }
}

export interface ReferralProgramConfig {
  // Master on/off for the ambassador referral program. When off, referral codes
  // are rejected at checkout and no new commissions accrue.
  enabled: boolean;
  // Customer discount a valid referral code applies (percent).
  discountPercent: number;
  // Personal discount an approved ambassador gets on their OWN purchases.
  personalDiscountPercent: number;
  // Default commission rate used when an ambassador has no explicit rate.
  defaultCommissionPercent: number;
  // When true, referral attribution still happens but NO new commission accrues
  // (a global pause the admin can toggle without disabling every ambassador).
  commissionsPaused: boolean;
}

function clampPercent(value: unknown, fallback: number): number {
  // Blank means "keep the default" — Number("") is 0, which would silently
  // zero out a referral/commission percent.
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

// Ambassador/referral program controls (Control Center → Referral Program).
// Defaults keep the program ON with a 10% customer discount, a 20% personal
// ambassador discount, a 10% default commission, and commissions running.
export async function getReferralProgramConfig(): Promise<ReferralProgramConfig> {
  const fallback: ReferralProgramConfig = {
    enabled: true,
    discountPercent: DEFAULT_REFERRAL_DISCOUNT_PERCENT,
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
  /** Payment-processor fee the store pays, as a percent of the amount charged. */
  processingFeePercent: number;
  /**
   * Whether the processor charges its fee on collected sales tax too. Most
   * processors DO charge on the full transaction (default true); set false if
   * yours excludes tax from the fee base.
   */
  processingFeeIncludesTax: boolean;
  /**
   * Whether collected sales tax counts toward net profit. True = the owner
   * keeps it (counted as profit); false = it's a pass-through remitted to the
   * state and excluded from profit.
   */
  countSalesTaxAsProfit: boolean;
  /**
   * Estimated shipping-label cost used for an order's profit BEFORE it ships
   * (and the cost charged to the checkout profit guard). Once an order ships,
   * this estimate is replaced per-order by the exact label cost — see
   * order-profit-shipping-reconciliation.sql.
   */
  shippingCostPerOrder: number;
}

// Default: never sell at a loss (profit >= $0). Raise the minimums in the
// Control Center to require a margin buffer beyond break-even. The processor
// fee (8%) and shipping estimate ($6) are the store's real economics; both are
// editable in the Control Center.
export const DEFAULT_PROFIT_CONFIG: ProfitSettingsConfig = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  worstCaseUnitCost: 33,
  processingFeePercent: PROCESSING_FEE_DEFAULT_PERCENT,
  processingFeeIncludesTax: true,
  // FALSE BY OWNER'S DECISION. Collected sales tax is money held on behalf of a
  // state, not the store's to keep, and this store files a remittance return for
  // exactly that reason. Counting it as profit overstated every profit figure by
  // the tax on every order.
  //
  // THIS DEFAULT ONLY APPLIES WHEN THE KEY IS ABSENT. The Control Center writes
  // `count_sales_tax_as_profit` on every save of its Profit section
  // (admin-control-center-client.tsx:308), so an admin_control row very likely
  // already holds `true` — in which case this default is never consulted and the
  // stored value must be changed too. See docs/findings/BLOCK-F-PRODUCTION-CHANGES.md.
  countSalesTaxAsProfit: false,
  shippingCostPerOrder: 6,
};

export async function getProfitSettings(): Promise<ProfitSettingsConfig> {
  try {
    const snapshot = await getControlSnapshot("profit");
    const profit = snapshot.profit ?? {};
    const num = (value: unknown, fallback: number) => {
      // Blank = default; a blank worst-case unit cost must never become $0
      // (that would defang the profit guard).
      if (value === "" || value == null) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      minProfitPercent: num(profit.min_profit_percent, DEFAULT_PROFIT_CONFIG.minProfitPercent),
      minProfitDollars: num(profit.min_profit_dollars, DEFAULT_PROFIT_CONFIG.minProfitDollars),
      worstCaseUnitCost: num(profit.worst_case_unit_cost, DEFAULT_PROFIT_CONFIG.worstCaseUnitCost),
      // THE SAME RESOLVER THE DISPLAY USES. Keeping a private copy of the rule
      // here is what let the Control Center advertise a rate that was not in
      // effect, and left the field with no upper bound at all.
      processingFeePercent:
        parseRatePercent(profit.processing_fee_percent) ?? DEFAULT_PROFIT_CONFIG.processingFeePercent,
      processingFeeIncludesTax: profit.processing_fee_includes_tax === undefined || profit.processing_fee_includes_tax === null || profit.processing_fee_includes_tax === ""
        ? DEFAULT_PROFIT_CONFIG.processingFeeIncludesTax
        : profit.processing_fee_includes_tax !== false && profit.processing_fee_includes_tax !== "false",
      countSalesTaxAsProfit: profit.count_sales_tax_as_profit === undefined || profit.count_sales_tax_as_profit === null || profit.count_sales_tax_as_profit === ""
        ? DEFAULT_PROFIT_CONFIG.countSalesTaxAsProfit
        : profit.count_sales_tax_as_profit !== false && profit.count_sales_tax_as_profit !== "false",
      // The estimate reads the new "shipping_cost_estimate" key first, then the
      // legacy "shipping_cost_per_order" key, so existing configs keep working.
      shippingCostPerOrder: num(
        profit.shipping_cost_estimate ?? profit.shipping_cost_per_order,
        DEFAULT_PROFIT_CONFIG.shippingCostPerOrder,
      ),
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

// Admin-editable shipping config (Control Center → Shipping). A blank/invalid
// field falls back to the coded default in shipping.ts, so the checkout math
// keeps working before an admin ever touches these. The domestic flat rate +
// free-shipping threshold are exposed in the Control Center; international
// rates keep their defaults. There is no service/handling fee.
export async function getShippingConfig(): Promise<ShippingConfig> {
  try {
    const snapshot = await getControlSnapshot("shipping");
    const shipping = snapshot.shipping ?? {};

    // A BLANK field means "keep the default" (what the Control Center UI
    // promises) — Number("") is 0, so without the explicit blank check a
    // blank flat rate/threshold silently became $0 and made every order ship
    // free. An explicit "0" is still honored as a real zero.
    const num = (value: unknown, fallback: number): number => {
      if (value === "" || value == null) return fallback;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };

    return {
      domesticFee: num(shipping.flat_rate, DEFAULT_SHIPPING_CONFIG.domesticFee),
      freeShippingThreshold: num(shipping.free_shipping_threshold, DEFAULT_SHIPPING_CONFIG.freeShippingThreshold),
      northAmericaFee: num(shipping.north_america_flat_rate, DEFAULT_SHIPPING_CONFIG.northAmericaFee),
      northAmericaFreeShippingThreshold: num(shipping.north_america_free_shipping_threshold, DEFAULT_SHIPPING_CONFIG.northAmericaFreeShippingThreshold),
      internationalFee: num(shipping.international_flat_rate, DEFAULT_SHIPPING_CONFIG.internationalFee),
      internationalFreeShippingThreshold: num(shipping.international_free_shipping_threshold, DEFAULT_SHIPPING_CONFIG.internationalFreeShippingThreshold),
    };
  } catch {
    return DEFAULT_SHIPPING_CONFIG;
  }
}

/**
 * A blank admin field means "I have nothing to say here", not "render nothing".
 *
 * Every caller of this config writes `control.x ?? "designed default"`, and `??`
 * only fires on null/undefined — so an empty or whitespace-only string stored
 * against a homepage field passed straight through and rendered as an empty
 * element. That is how the homepage hero came to show its eyebrow and its two
 * buttons with no headline and no subheadline between them: not missing markup,
 * an empty string winning over the fallback.
 *
 * Collapsing blank to undefined restores the designed copy and cannot change
 * what any non-blank value renders.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function getHomepageControlConfig(): Promise<HomepageControlConfig> {
  try {
    const snapshot = await getControlSnapshot();
    const homepage = snapshot.homepage ?? {};
    const promotions = snapshot.promotions ?? {};
    return {
      promoTickerItems: Array.isArray(homepage.promo_ticker_items) ? homepage.promo_ticker_items as string[] : undefined,
      heroKicker: text(homepage.hero_kicker),
      heroHeadline: text(homepage.hero_headline),
      heroSubheadline: text(homepage.hero_subheadline),
      promoPills: Array.isArray(homepage.promo_pills) ? homepage.promo_pills as string[] : undefined,
      promoCaption: text(homepage.promo_caption),
      featuredProductSlugs: Array.isArray(homepage.featured_product_slugs) ? homepage.featured_product_slugs as string[] : undefined,
      qualityPanelTitle: text(homepage.quality_panel_title),
      qualityPanelItems: Array.isArray(homepage.quality_panel_items) ? homepage.quality_panel_items as string[] : undefined,
      promoBuy3Get1Enabled: Boolean(promotions.buy_3_get_1_enabled ?? false),
      promoBuy2Get1HalfEnabled: Boolean(promotions.buy_2_get_1_half_enabled ?? false),
      bundleStacking: promotions.bundle_stacking === true,
      bundleConfig: resolveBundleConfig({
        twoUnitPercent: promotions.bundle_two_unit_percent,
        threePlusPercent: promotions.bundle_three_plus_percent,
      }),
    };
  } catch {
    return {};
  }
}