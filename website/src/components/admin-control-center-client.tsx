"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { US_STATE_TAX_TABLE } from "@/lib/sales-tax";
// NOT from "@/lib/admin-control" — that module starts with `import
// "server-only"`, which Next.js hard-errors on if any Client Component's
// module graph reaches it (even for an unrelated, dependency-free export).
// This client-safe file holds the one piece this component actually needs.
import { describeEffectiveRate, PROCESSING_FEE_DEFAULT_PERCENT } from "@/lib/admin-control-shared";
import { buildControlUpdates, type ControlUpdate } from "@/lib/admin-control-updates";
import { DEFAULT_SHIPPING_CONFIG } from "@/lib/shipping";

type ControlSnapshot = Record<string, Record<string, unknown>>;

/**
 * What the server will say about the order-notification destination.
 *
 * No credential appears here, by design: not the Pushover token, not the user
 * key, and not the webhook URL — which is itself the webhook's only credential.
 */
type PushStatus = {
  configured: boolean;
  kind: "pushover" | "webhook" | "none";
  /** true healthy, false broken, null genuinely unknown (a webhook). */
  healthy: boolean | null;
  detail: string;
  checkedAt: string;
};

/**
 * The referral rates as the BUSINESS LOGIC resolves them, with the provenance
 * of each. Declared at module scope rather than inline in the loader: writing
 * `typeof referralEffective` inside the fetch made the loader read as though it
 * depended on that state, which is not true and which the hooks lint rightly
 * complains about.
 */
type ReferralEffective = {
  personalDiscountPercent: number;
  personalDiscountSource: string;
  discountPercent: number;
  discountSource: string;
  defaultCommissionPercent: number;
  defaultCommissionSource: string;
};

type SectionKey = "homepage" | "promotions" | "shipping" | "content" | "settings" | "security" | "notifications";

const SECTION_LABELS: Record<SectionKey, string> = {
  homepage: "Homepage",
  promotions: "Promotions",
  shipping: "Shipping",
  content: "Content",
  settings: "Website Settings",
  security: "Security",
  notifications: "Order Notifications",
};

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AdminControlCenterClient() {
  const [saving, setSaving] = useState(false);
  /**
   * Whether a snapshot has actually landed (F-02).
   *
   * Every field below initialises blank, so an unloaded form and a form the
   * operator emptied by hand are the same object. Until this is true the save
   * button is disabled and buildControlUpdates refuses to emit anything --
   * because on 2026-08-15 a save over an unloaded form wrote "" across every
   * key it owns, and the store stopped charging sales tax for eight days.
   */
  const [loaded, setLoaded] = useState(false);
  /** The stored snapshot the fields were populated from, keyed "section.key". */
  const [baseline, setBaseline] = useState<Record<string, unknown>>({});
  const [quickSaving, setQuickSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [homepageHeroHeadline, setHomepageHeroHeadline] = useState("");
  const [homepageHeroSubheadline, setHomepageHeroSubheadline] = useState("");
  const [homepageTickerItems, setHomepageTickerItems] = useState("");
  const [homepagePromoPills, setHomepagePromoPills] = useState("");
  const [homepageFeaturedSlugs, setHomepageFeaturedSlugs] = useState("");

  const [promoBuy3Get1Enabled, setPromoBuy3Get1Enabled] = useState(false);
  const [bundleTwoUnitPercent, setBundleTwoUnitPercent] = useState("");
  const [bundleThreePlusPercent, setBundleThreePlusPercent] = useState("");
  const [promoBuy2Get1HalfEnabled, setPromoBuy2Get1HalfEnabled] = useState(false);
  const [promoAnnouncement, setPromoAnnouncement] = useState("");

  const [shippingFlatRate, setShippingFlatRate] = useState("");
  const [shippingFreeThreshold, setShippingFreeThreshold] = useState("");
  const [shippingIntlFlatRate, setShippingIntlFlatRate] = useState("");
  const [shippingIntlFreeThreshold, setShippingIntlFreeThreshold] = useState("");
  const [shippingNaFlatRate, setShippingNaFlatRate] = useState("");
  const [shippingNaFreeThreshold, setShippingNaFreeThreshold] = useState("");
  const [shippingProtectionPercent, setShippingProtectionPercent] = useState("");
  // Sales tax nexus: the states where the store is registered and must
  // collect. Checkout collects tax ONLY for these destinations, at each
  // state's built-in combined rate (override-able below).
  const [taxNexusStates, setTaxNexusStates] = useState<string[]>([]);
  const [taxRateOverrides, setTaxRateOverrides] = useState("");

  const [contentFaq, setContentFaq] = useState("");
  const [contentPolicies, setContentPolicies] = useState("");
  const [contentContactEmail, setContentContactEmail] = useState("");
  const [pushoverToken, setPushoverToken] = useState("");
  const [pushoverUserKey, setPushoverUserKey] = useState("");
  const [orderPushWebhookUrl, setOrderPushWebhookUrl] = useState("");
  const [pushoverSound, setPushoverSound] = useState("");
  const [pushTesting, setPushTesting] = useState(false);
  const [pushTestResult, setPushTestResult] = useState<string | null>(null);
  /** Which credentials the server holds. Their VALUES never reach this file. */
  const [secretsSet, setSecretsSet] = useState<Record<string, boolean>>({});
  const [pushStatus, setPushStatus] = useState<PushStatus | null>(null);
  const [pushStatusLoading, setPushStatusLoading] = useState(false);
  const [alertEmail, setAlertEmail] = useState("");
  const [contentFooterLinks, setContentFooterLinks] = useState("");
  const [contentLegalPages, setContentLegalPages] = useState("");

  const [businessName, setBusinessName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [brandColors, setBrandColors] = useState("");
  const [paymentProvider, setPaymentProvider] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [socialLinks, setSocialLinks] = useState("");
  const [seoDefaults, setSeoDefaults] = useState("");
  const [maintenanceMode, setMaintenanceMode] = useState(false);

  const [require2fa, setRequire2fa] = useState(false);
  const [suspiciousAlertsEmail, setSuspiciousAlertsEmail] = useState("");
  const [backupSchedule, setBackupSchedule] = useState("daily");
  const [rolePolicy, setRolePolicy] = useState("");

  // Referral / ambassador program + coupon policy controls.
  const [referralEnabled, setReferralEnabled] = useState(true);
  const [referralPersonalDiscount, setReferralPersonalDiscount] = useState("");
  const [referralDiscount, setReferralDiscount] = useState("");
  const [referralDefaultCommission, setReferralDefaultCommission] = useState("");
  const [referralCommissionsPaused, setReferralCommissionsPaused] = useState(false);
  const [couponsEnabled, setCouponsEnabled] = useState(true);
  const [couponAllowStacking, setCouponAllowStacking] = useState(false);
  const [bundleStacking, setBundleStacking] = useState(false);

  // Profit protection thresholds (used by the profit engine).
  const [profitMinPercent, setProfitMinPercent] = useState("");
  const [profitMinDollars, setProfitMinDollars] = useState("");
  const [profitWorstCaseCost, setProfitWorstCaseCost] = useState("");
  const [profitProcessingFee, setProfitProcessingFee] = useState("");
  const [profitShippingEstimate, setProfitShippingEstimate] = useState("");
  const [profitFeeIncludesTax, setProfitFeeIncludesTax] = useState(true);
  const [profitCountTax, setProfitCountTax] = useState(true);
  /**
   * What the referral rates actually resolve to, straight from the same
   * function checkout uses, plus whether each came from a stored value or the
   * code default. Displayed rather than inferred: an input box showing "20"
   * and an empty input box that means "20 by default" look different to the
   * code and identical to a person.
   */
  const [referralEffective, setReferralEffective] = useState<ReferralEffective | null>(null);

  /**
   * Whether the owner's phone would actually hear about an order, asked live.
   *
   * Deliberately not a remembered result: "healthy as of this morning" is the
   * kind of reassurance that let a dead destination look fine while a paid
   * order went unannounced.
   */
  const loadPushStatus = async () => {
    setPushStatusLoading(true);
    try {
      const res = await fetch("/api/admin/notifications/test", { cache: "no-store" });
      const json = await res.json() as { success: boolean; status?: PushStatus };
      setPushStatus(json.status ?? null);
    } catch {
      setPushStatus(null);
    } finally {
      setPushStatusLoading(false);
    }
  };

  const loadSnapshot = async () => {
    const res = await fetch("/api/admin/control", { cache: "no-store" });
    const json = await res.json() as {
      success: boolean;
      snapshot?: ControlSnapshot;
      secretsSet?: Record<string, boolean>;
      effective?: { referral?: ReferralEffective | null };
      error?: string;
    };
    if (!res.ok || !json.success) {
      // Stay UNLOADED on failure. The previous version only set a message and
      // left the save button live over a form full of empty inputs, which is
      // one of the two ways the 2026-08-15 blanking save became possible.
      setLoaded(false);
      setMessage(json.error ?? "Unable to load settings — settings cannot be saved until this succeeds.");
      return;
    }

    setReferralEffective(json.effective?.referral ?? null);

    const next = json.snapshot ?? {};
    setReferralEffective(json.effective?.referral ?? null);

    const homepage = next.homepage ?? {};
    setHomepageHeroHeadline(String(homepage.hero_headline ?? ""));
    setHomepageHeroSubheadline(String(homepage.hero_subheadline ?? ""));
    setHomepageTickerItems(Array.isArray(homepage.promo_ticker_items) ? (homepage.promo_ticker_items as string[]).join(", ") : "");
    setHomepagePromoPills(Array.isArray(homepage.promo_pills) ? (homepage.promo_pills as string[]).join(", ") : "");
    setHomepageFeaturedSlugs(Array.isArray(homepage.featured_product_slugs) ? (homepage.featured_product_slugs as string[]).join(", ") : "");

    const promotions = next.promotions ?? {};
    setPromoBuy3Get1Enabled(Boolean(promotions.buy_3_get_1_enabled ?? false));
    setBundleTwoUnitPercent(String(promotions.bundle_two_unit_percent ?? ""));
    setBundleThreePlusPercent(String(promotions.bundle_three_plus_percent ?? ""));
    setPromoBuy2Get1HalfEnabled(Boolean(promotions.buy_2_get_1_half_enabled ?? false));
    setPromoAnnouncement(String(promotions.sitewide_announcement ?? ""));

    const shipping = next.shipping ?? {};
    setShippingFlatRate(String(shipping.flat_rate ?? ""));
    setShippingFreeThreshold(String(shipping.free_shipping_threshold ?? ""));
    setShippingIntlFlatRate(String(shipping.international_flat_rate ?? ""));
    setShippingIntlFreeThreshold(String(shipping.international_free_shipping_threshold ?? ""));
    setShippingNaFlatRate(String(shipping.north_america_flat_rate ?? ""));
    setShippingNaFreeThreshold(String(shipping.north_america_free_shipping_threshold ?? ""));
    setShippingProtectionPercent(String(shipping.protection_percent ?? ""));
    const tax = next.tax ?? {};
    setTaxNexusStates(String(tax.nexus_states ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => Boolean(US_STATE_TAX_TABLE[s])));
    setTaxRateOverrides(String(tax.rate_overrides ?? ""));

    const content = next.content ?? {};
    setContentFaq(String(content.faq ?? ""));
    setContentPolicies(String(content.policies ?? ""));
    setContentContactEmail(String(content.contact_email ?? ""));
    setContentFooterLinks(String(content.footer_links ?? ""));
    setContentLegalPages(String(content.legal_pages ?? ""));

    const notifications = next.notifications ?? {};
    // The server sends "" for both credentials whatever it holds, so these stay
    // empty on purpose: an empty field means "leave the stored one alone".
    setPushoverToken("");
    setPushoverUserKey("");
    setSecretsSet(json.secretsSet ?? {});
    setPushoverSound(String(notifications.pushover_sound ?? ""));
    setOrderPushWebhookUrl(String(notifications.order_push_webhook_url ?? ""));
    setAlertEmail(String((next.alerts ?? {}).email ?? ""));

    const settings = next.settings ?? {};
    setBusinessName(String(settings.business_name ?? ""));
    setLogoUrl(String(settings.logo_url ?? ""));
    setBrandColors(String(settings.brand_colors ?? ""));
    setPaymentProvider(String(settings.payment_provider ?? ""));
    setEmailFrom(String(settings.email_from ?? ""));
    setSocialLinks(String(settings.social_links ?? ""));
    setSeoDefaults(String(settings.seo_defaults ?? ""));
    setMaintenanceMode(Boolean(settings.maintenance_mode ?? false));

    const security = next.security ?? {};
    setRequire2fa(Boolean(security.require_2fa ?? false));
    setSuspiciousAlertsEmail(String(security.suspicious_alerts_email ?? ""));
    setBackupSchedule(String(security.backup_schedule ?? "daily"));
    setRolePolicy(String(security.role_policy ?? ""));

    const referral = next.referral ?? {};
    setReferralEnabled(referral.enabled !== false);
    setReferralPersonalDiscount(referral.personal_discount_percent != null ? String(referral.personal_discount_percent) : "");
    setReferralDiscount(referral.discount_percent != null ? String(referral.discount_percent) : "");
    setReferralDefaultCommission(referral.default_commission_percent != null ? String(referral.default_commission_percent) : "");
    setReferralCommissionsPaused(referral.commissions_paused === true);

    const coupons = next.coupons ?? {};
    setCouponsEnabled(coupons.enabled !== false);
    setCouponAllowStacking(coupons.allow_stacking === true);
    setBundleStacking(promotions.bundle_stacking === true);

    const profit = next.profit ?? {};
    setProfitMinPercent(profit.min_profit_percent != null ? String(profit.min_profit_percent) : "");
    setProfitMinDollars(profit.min_profit_dollars != null ? String(profit.min_profit_dollars) : "");
    setProfitWorstCaseCost(profit.worst_case_unit_cost != null ? String(profit.worst_case_unit_cost) : "");
    setProfitProcessingFee(profit.processing_fee_percent != null ? String(profit.processing_fee_percent) : "");
    setProfitShippingEstimate(
      profit.shipping_cost_estimate != null
        ? String(profit.shipping_cost_estimate)
        : profit.shipping_cost_per_order != null
          ? String(profit.shipping_cost_per_order)
          : "",
    );
    setProfitFeeIncludesTax(profit.processing_fee_includes_tax !== false && profit.processing_fee_includes_tax !== "false");
    // FALSE UNLESS STORED TRUE. The server default (admin-control.ts
    // DEFAULT_PROFIT_CONFIG) is false by the owner's decision — collected sales
    // tax is not the store's money. This used to default the select to Yes
    // whenever the key had never been stored, and the changed-keys diff then
    // wrote `true` on the next save of ANY field, silently overstating every
    // profit figure by the tax on every order.
    setProfitCountTax(profit.count_sales_tax_as_profit === true || profit.count_sales_tax_as_profit === "true");

    // Remember exactly what was stored, so a save can send the operator's edits
    // rather than the whole form. Flattened to the "section.key" paths
    // buildControlUpdates compares against.
    const flattened: Record<string, unknown> = {};
    for (const [section, entries] of Object.entries(next)) {
      for (const [key, value] of Object.entries(entries ?? {})) {
        flattened[`${section}.${key}`] = value;
      }
    }
    setBaseline(flattened);
    setLoaded(true);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSnapshot();
      void loadPushStatus();
    }, 0);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel("admin-control-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "admin_audit_logs" }, () => {
        void loadSnapshot();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const summaryCards = useMemo(() => {
    return [
      { title: "Products", href: "/admin/products", detail: "Catalog, variants, pricing, inventory" },
      { title: "Orders", href: "/admin/orders", detail: "Payments, shipping status, exports" },
      { title: "Partners", href: "/admin/partners", detail: "Applications, commissions, payouts" },
      { title: "Control Center", href: "#control-editor", detail: "Homepage, promos, content, settings" },
    ];
  }, []);

  const saveAll = async () => {
    // RULE 1 (F-02): an unloaded form cannot write. Belt and braces with the
    // disabled button -- a keyboard submit or a double click during the load
    // window must not reach the network either.
    if (!loaded) {
      setMessage("Settings have not loaded yet — nothing was saved.");
      return;
    }

    setSaving(true);
    setMessage(null);

    const desired: ControlUpdate[] = [
      { section: "homepage", key: "hero_headline", value: homepageHeroHeadline },
      { section: "homepage", key: "hero_subheadline", value: homepageHeroSubheadline },
      { section: "homepage", key: "promo_ticker_items", value: parseCsv(homepageTickerItems) },
      { section: "homepage", key: "promo_pills", value: parseCsv(homepagePromoPills) },
      { section: "homepage", key: "featured_product_slugs", value: parseCsv(homepageFeaturedSlugs) },

      { section: "promotions", key: "buy_3_get_1_enabled", value: promoBuy3Get1Enabled },
      { section: "promotions", key: "bundle_two_unit_percent", value: bundleTwoUnitPercent },
      { section: "promotions", key: "bundle_three_plus_percent", value: bundleThreePlusPercent },
      { section: "promotions", key: "buy_2_get_1_half_enabled", value: promoBuy2Get1HalfEnabled },
      { section: "promotions", key: "sitewide_announcement", value: promoAnnouncement },

      { section: "shipping", key: "flat_rate", value: shippingFlatRate },
      { section: "shipping", key: "free_shipping_threshold", value: shippingFreeThreshold },
      { section: "shipping", key: "international_flat_rate", value: shippingIntlFlatRate },
      { section: "shipping", key: "international_free_shipping_threshold", value: shippingIntlFreeThreshold },
      { section: "shipping", key: "north_america_flat_rate", value: shippingNaFlatRate },
      { section: "shipping", key: "north_america_free_shipping_threshold", value: shippingNaFreeThreshold },
      { section: "shipping", key: "protection_percent", value: shippingProtectionPercent },
      { section: "tax", key: "nexus_states", value: taxNexusStates.join(",") },
      { section: "tax", key: "rate_overrides", value: taxRateOverrides },

      { section: "content", key: "faq", value: contentFaq },
      { section: "content", key: "policies", value: contentPolicies },
      { section: "content", key: "contact_email", value: contentContactEmail },
      { section: "content", key: "footer_links", value: contentFooterLinks },
      { section: "content", key: "legal_pages", value: contentLegalPages },

      { section: "notifications", key: "pushover_token", value: pushoverToken },
      { section: "notifications", key: "pushover_user_key", value: pushoverUserKey },
      { section: "notifications", key: "pushover_sound", value: pushoverSound },
      { section: "notifications", key: "order_push_webhook_url", value: orderPushWebhookUrl },
      { section: "alerts", key: "email", value: alertEmail },

      { section: "settings", key: "business_name", value: businessName },
      { section: "settings", key: "logo_url", value: logoUrl },
      { section: "settings", key: "brand_colors", value: brandColors },
      { section: "settings", key: "payment_provider", value: paymentProvider },
      { section: "settings", key: "email_from", value: emailFrom },
      { section: "settings", key: "social_links", value: socialLinks },
      { section: "settings", key: "seo_defaults", value: seoDefaults },
      { section: "settings", key: "maintenance_mode", value: maintenanceMode },

      { section: "security", key: "require_2fa", value: require2fa },
      { section: "security", key: "suspicious_alerts_email", value: suspiciousAlertsEmail },
      { section: "security", key: "backup_schedule", value: backupSchedule },
      { section: "security", key: "role_policy", value: rolePolicy },

      { section: "referral", key: "enabled", value: referralEnabled },
      { section: "referral", key: "personal_discount_percent", value: referralPersonalDiscount },
      { section: "referral", key: "discount_percent", value: referralDiscount },
      { section: "referral", key: "default_commission_percent", value: referralDefaultCommission },
      { section: "referral", key: "commissions_paused", value: referralCommissionsPaused },

      { section: "coupons", key: "enabled", value: couponsEnabled },
      { section: "coupons", key: "allow_stacking", value: couponAllowStacking },
      { section: "promotions", key: "bundle_stacking", value: bundleStacking },

      { section: "profit", key: "min_profit_percent", value: profitMinPercent },
      { section: "profit", key: "min_profit_dollars", value: profitMinDollars },
      { section: "profit", key: "worst_case_unit_cost", value: profitWorstCaseCost },
      { section: "profit", key: "processing_fee_percent", value: profitProcessingFee },
      { section: "profit", key: "shipping_cost_estimate", value: profitShippingEstimate },
      { section: "profit", key: "processing_fee_includes_tax", value: profitFeeIncludesTax },
      { section: "profit", key: "count_sales_tax_as_profit", value: profitCountTax },
    ];

    // RULE 2 (F-02): send the edit, not the form. Unchanged keys are dropped,
    // and emptying a populated setting is tagged as a deliberate clear so the
    // server can tell it apart from an accidental blank.
    const updates = buildControlUpdates({ loaded, desired, baseline });

    if (updates.length === 0) {
      setMessage("No changes to save.");
      setSaving(false);
      return;
    }

    const res = await fetch("/api/admin/control", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });

    const json = await res.json() as { success: boolean; error?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Unable to save changes");
      setSaving(false);
      return;
    }

    setMessage(`Saved ${updates.length} change${updates.length === 1 ? "" : "s"}: ${updates.map((u) => `${u.section}.${u.key}`).join(", ")}.`);
    setSaving(false);
    void loadSnapshot();
  };

  // PROVE IT REACHES THE PHONE, HERE, NOW.
  //
  // Saving a token only proves it was typed. A $94.96 order was paid and
  // announced to nothing because the destination had quietly stopped working
  // and there was no way to find that out short of the next order. This sends a
  // real notification, and reports back what the destination actually said.
  const sendTestNotification = async () => {
    setPushTesting(true);
    setPushTestResult(null);
    try {
      const res = await fetch("/api/admin/notifications/test", { method: "POST" });
      const json = await res.json() as { success: boolean; error?: string; message?: string };
      setPushTestResult(json.success
        ? (json.message ?? "Sent.")
        : (json.error ?? "The test notification could not be sent."));
    } catch {
      setPushTestResult("Could not reach the server to send a test notification.");
    } finally {
      setPushTesting(false);
      void loadPushStatus();
    }
  };

  /**
   * Turn direct Pushover off again.
   *
   * The panel can no longer read a stored credential, which is what makes a
   * blank field mean "keep". That leaves no way to say "delete it" by typing,
   * so removal is its own deliberate action — and it announces itself with
   * allowClear, the same flag the blanking backstop has always required.
   */
  const removePushoverCredentials = async () => {
    if (!window.confirm("Remove the stored Pushover credentials? Order notifications will fall back to the webhook, or stop.")) return;
    setPushTestResult(null);
    try {
      const res = await fetch("/api/admin/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [
            { section: "notifications", key: "pushover_token", value: "", allowClear: true },
            { section: "notifications", key: "pushover_user_key", value: "", allowClear: true },
          ],
        }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      setPushTestResult(res.ok && json.success ? "Pushover credentials removed." : (json.error ?? "Unable to remove the credentials."));
    } catch {
      setPushTestResult("Unable to reach the server to remove the credentials.");
    } finally {
      void loadSnapshot();
      void loadPushStatus();
    }
  };

  const setMaintenanceInstant = async (enabled: boolean) => {
    const confirmation = enabled
      ? "Freeze public site now? Admin access will stay available."
      : "Unfreeze public site and resume public traffic now?";

    if (!window.confirm(confirmation)) {
      return;
    }

    setQuickSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/admin/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [{ section: "settings", key: "maintenance_mode", value: enabled }],
        }),
      });

      const json = await res.json() as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Unable to update maintenance mode");
        return;
      }

      setMaintenanceMode(enabled);
      setMessage(enabled ? "Site is now frozen for visitors." : "Site is live again.");
    } catch {
      setMessage("Unable to update maintenance mode right now.");
    } finally {
      setQuickSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => (
          <Link key={card.title} href={card.href} className="vl-panel rounded-2xl p-4 transition hover:border-white/30">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Module</p>
            <h2 className="mt-2 text-lg font-semibold text-white">{card.title}</h2>
            <p className="mt-1 text-sm text-zinc-400">{card.detail}</p>
          </Link>
        ))}
      </section>

      <section id="control-editor" className="vl-panel rounded-[1.6rem] p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">No-Code Control Editor</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Manage Website Operations</h2>
            <p className="mt-2 text-sm text-zinc-400">Update live website controls, promotions, and policy text without editing code.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMaintenanceInstant(!maintenanceMode)}
              disabled={quickSaving}
              className={`${maintenanceMode ? "vl-btn-secondary" : "vl-btn-primary"} vl-focus-ring px-5 py-3 text-sm disabled:opacity-60`}
            >
              {quickSaving ? "Updating..." : maintenanceMode ? "Unfreeze Site" : "Freeze Site Now"}
            </button>
            <button type="button" onClick={saveAll} disabled={saving || !loaded} className="vl-btn-primary vl-focus-ring px-5 py-3 text-sm disabled:opacity-60">
              {saving ? "Saving..." : loaded ? "Save Changes" : "Loading settings..."}
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.homepage}</h3>
            <div className="mt-3 space-y-3 text-sm">
              <label className="block text-zinc-300">Hero headline<input value={homepageHeroHeadline} onChange={(e) => setHomepageHeroHeadline(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Hero subheadline<input value={homepageHeroSubheadline} onChange={(e) => setHomepageHeroSubheadline(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Ticker items (comma-separated)<input value={homepageTickerItems} onChange={(e) => setHomepageTickerItems(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Promo pills (comma-separated)<input value={homepagePromoPills} onChange={(e) => setHomepagePromoPills(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Featured product slugs (comma-separated)<input value={homepageFeaturedSlugs} onChange={(e) => setHomepageFeaturedSlugs(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.promotions}</h3>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <label className="text-zinc-300 sm:col-span-2">Sitewide announcement<input value={promoAnnouncement} onChange={(e) => setPromoAnnouncement(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="flex items-center gap-2 text-zinc-300 sm:col-span-2"><input type="checkbox" checked={promoBuy3Get1Enabled} onChange={(e) => setPromoBuy3Get1Enabled(e.target.checked)} /> Enable Buy 3 Get 1 Free</label>
              <label className="block text-zinc-300">Bundle &amp; Save — 2 units (% off)<input value={bundleTwoUnitPercent} onChange={(e) => setBundleTwoUnitPercent(e.target.value)} placeholder="5" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Bundle &amp; Save — 3+ units (% off)<input value={bundleThreePlusPercent} onChange={(e) => setBundleThreePlusPercent(e.target.value)} placeholder="8" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="flex items-center gap-2 text-zinc-300 sm:col-span-2"><input type="checkbox" checked={promoBuy2Get1HalfEnabled} onChange={(e) => setPromoBuy2Get1HalfEnabled(e.target.checked)} /> Enable Buy 2 Get 1 (50% Off)</label>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Coupon codes are managed separately with real redemption tracking — see{" "}
              <Link href="/admin/coupons" className="text-zinc-300 underline hover:text-white">Coupons</Link>.
            </p>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.shipping}</h3>
            {/* Rendered from DEFAULT_SHIPPING_CONFIG, never retyped: this
                sentence is the admin's only statement of what "blank" means,
                so a hard-coded $200 here would go on promising the old
                threshold the moment the coded default changed. */}
            <p className="mt-2 text-xs text-zinc-400">These apply live at checkout. Leave a field blank to keep the default (domestic flat rate ${DEFAULT_SHIPPING_CONFIG.domesticFee}, free over ${DEFAULT_SHIPPING_CONFIG.freeShippingThreshold}).</p>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <label className="text-zinc-300">Domestic flat rate ($)<input value={shippingFlatRate} onChange={(e) => setShippingFlatRate(e.target.value)} placeholder="15" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Free shipping over ($)<input value={shippingFreeThreshold} onChange={(e) => setShippingFreeThreshold(e.target.value)} placeholder={String(DEFAULT_SHIPPING_CONFIG.freeShippingThreshold)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Canada flat rate ($)<input value={shippingNaFlatRate} onChange={(e) => setShippingNaFlatRate(e.target.value)} placeholder="25" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Canada free shipping over ($)<input value={shippingNaFreeThreshold} onChange={(e) => setShippingNaFreeThreshold(e.target.value)} placeholder="400" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">International flat rate ($)<input value={shippingIntlFlatRate} onChange={(e) => setShippingIntlFlatRate(e.target.value)} placeholder="60" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">International free shipping over ($)<input value={shippingIntlFreeThreshold} onChange={(e) => setShippingIntlFreeThreshold(e.target.value)} placeholder="600" className="vl-input mt-1 w-full px-3 py-2" /></label>
              {/* Shipping Protection rate. A PERCENT, not a dollar amount — the
                  add-on is priced off the merchandise subtotal, so this field
                  scales the fee on every cart the moment it is saved. Blank
                  keeps the coded default; a value outside 0-100 is ignored on
                  read (getShippingConfig falls back to the default) so a typo
                  cannot multiply an order total. */}
              <label className="text-zinc-300">Shipping protection rate (%)<input value={shippingProtectionPercent} onChange={(e) => setShippingProtectionPercent(e.target.value)} placeholder={String(DEFAULT_SHIPPING_CONFIG.protectionPercent ?? "")} className="vl-input mt-1 w-full px-3 py-2" /></label>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Sales Tax</h3>
            <p className="mt-2 text-xs text-zinc-400">
              Tax is now calculated from the customer&apos;s shipping address. Check each state where the business is
              registered to collect sales tax (your nexus states — home state plus anywhere you&apos;ve crossed an economic
              threshold). Orders shipping to those states are taxed at the state&apos;s combined average rate shown;
              orders to every other state collect <span className="text-zinc-200">$0</span>. With no states checked,
              no tax is collected anywhere.
            </p>
            <div className="mt-3 grid grid-cols-3 gap-1.5 text-xs sm:grid-cols-5 lg:grid-cols-7">
              {Object.entries(US_STATE_TAX_TABLE).map(([code, rule]) => {
                const checked = taxNexusStates.includes(code);
                return (
                  <label key={code} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 ${checked ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : "border-white/10 bg-white/[0.02] text-zinc-400"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => setTaxNexusStates((prev) => e.target.checked ? [...prev, code] : prev.filter((s) => s !== code))}
                      className="h-3 w-3 accent-emerald-500"
                    />
                    <span className="font-medium">{code}</span>
                    <span className="ml-auto tabular-nums">{rule.ratePercent}%</span>
                  </label>
                );
              })}
            </div>
            <label className="mt-3 block text-sm text-zinc-300">
              Rate overrides (JSON, optional)
              <input value={taxRateOverrides} onChange={(e) => setTaxRateOverrides(e.target.value)} placeholder='{"TX": 8.25}' className="vl-input mt-1 w-full px-3 py-2 font-mono text-xs" />
              <span className="mt-1 block text-xs text-zinc-500">Pin an exact rate for a nexus state when you know a better figure than the built-in combined average. Rates stay current automatically once a tax service (TaxJar / Avalara) is connected.</span>
            </label>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.content}</h3>
            <div className="mt-3 space-y-3 text-sm">
              <label className="block text-zinc-300">FAQ content<textarea value={contentFaq} onChange={(e) => setContentFaq(e.target.value)} className="vl-input mt-1 min-h-20 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Policy content<textarea value={contentPolicies} onChange={(e) => setContentPolicies(e.target.value)} className="vl-input mt-1 min-h-20 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Contact email<input value={contentContactEmail} onChange={(e) => setContentContactEmail(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Footer links<textarea value={contentFooterLinks} onChange={(e) => setContentFooterLinks(e.target.value)} className="vl-input mt-1 min-h-16 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Legal pages<textarea value={contentLegalPages} onChange={(e) => setContentLegalPages(e.target.value)} className="vl-input mt-1 min-h-16 w-full px-3 py-2" /></label>
            </div>
          </section>

          {/* WHY THESE LIVE HERE RATHER THAN IN THE HOSTING ENVIRONMENT.
              A paid order went unannounced because the push webhook had died
              and the URL sat in an environment variable — so correcting it
              needed a redeploy, at exactly the moment orders were being missed.
              From this panel it is a ten-second edit. */}
          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.notifications}</h3>
            <p className="mt-1 text-[11px] text-zinc-500">
              Where &quot;you just got an order&quot; goes. Pushover is used directly when both of its fields are filled in —
              that is the shortest path and the one least likely to break. The webhook is the older Zapier route, kept as a fallback.
            </p>

            {/* THE STATE OF THE THING, NOT A PROMISE ABOUT IT.
                A dead destination and a healthy one looked identical from this
                screen, and the difference only showed up as an order nobody was
                told about. This is asked live on every load. */}
            <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs">
              {pushStatusLoading && !pushStatus ? (
                <span className="text-zinc-500">Checking the notification destination…</span>
              ) : !pushStatus ? (
                <span className="text-zinc-500">Notification status unavailable.</span>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className={
                      pushStatus.healthy === true
                        ? "rounded-full bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-300"
                        : pushStatus.healthy === false
                          ? "rounded-full bg-red-500/15 px-2 py-0.5 font-semibold text-red-300"
                          : "rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-300"
                    }
                  >
                    {pushStatus.healthy === true ? "Healthy" : pushStatus.healthy === false ? "Not working" : "Cannot be verified"}
                  </span>
                  <span className="text-zinc-300">
                    {pushStatus.kind === "pushover" ? "Pushover (direct)" : pushStatus.kind === "webhook" ? "Webhook fallback" : "Not configured"}
                  </span>
                  <span className="text-zinc-500">checked {new Date(pushStatus.checkedAt).toLocaleTimeString()}</span>
                  <button type="button" onClick={loadPushStatus} disabled={pushStatusLoading} className="vl-focus-ring text-zinc-400 underline disabled:opacity-60">
                    {pushStatusLoading ? "Checking…" : "Check again"}
                  </button>
                  <p className="w-full text-zinc-500">{pushStatus.detail}</p>
                </div>
              )}
            </div>

            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              {/* WRITE-ONLY. The server reports these as stored or not and never
                  sends the value back, so an empty box means "keep what you
                  have" rather than "delete it". */}
              <label className="text-zinc-300">Pushover API token
                <input type="password" autoComplete="new-password" value={pushoverToken} onChange={(e) => setPushoverToken(e.target.value)} placeholder={secretsSet["notifications.pushover_token"] ? "stored — type to replace" : "from pushover.net/apps/build"} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-zinc-300">Pushover user key
                <input type="password" autoComplete="new-password" value={pushoverUserKey} onChange={(e) => setPushoverUserKey(e.target.value)} placeholder={secretsSet["notifications.pushover_user_key"] ? "stored — type to replace" : "from your pushover.net dashboard"} className="vl-input mt-1 w-full px-3 py-2" />
              </label>
              <label className="text-zinc-300 sm:col-span-2">Pushover sound (optional)
                <input value={pushoverSound} onChange={(e) => setPushoverSound(e.target.value)} placeholder="the name of a sound in your Pushover account" className="vl-input mt-1 w-full px-3 py-2" />
                <span className="mt-1 block text-[11px] text-zinc-500">
                  Type the name exactly as Pushover lists it under Your Custom Sounds. Blank uses your device default. If Pushover ever rejects the
                  name, the order notification still goes out — without the sound.
                </span>
              </label>
              <label className="text-zinc-300 sm:col-span-2">Order push webhook URL (fallback)<input value={orderPushWebhookUrl} onChange={(e) => setOrderPushWebhookUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/..." className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300 sm:col-span-2">Critical alert email
                <input value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)} placeholder="you@example.com" className="vl-input mt-1 w-full px-3 py-2" />
                <span className="mt-1 block text-[11px] text-zinc-500">
                  Where a missed order or other critical alert is emailed. Kept separate from the public support address, which customers see.
                </span>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={sendTestNotification}
                disabled={pushTesting}
                className="vl-btn-secondary vl-focus-ring px-4 py-2 text-xs disabled:opacity-60"
              >
                {pushTesting ? "Sending…" : "Send test notification"}
              </button>
              {(secretsSet["notifications.pushover_token"] || secretsSet["notifications.pushover_user_key"]) ? (
                <button type="button" onClick={removePushoverCredentials} className="vl-focus-ring text-xs text-zinc-400 underline">
                  Remove stored Pushover credentials
                </button>
              ) : null}
              <span className="text-[11px] text-zinc-500">Save first — this uses the settings already stored, not what is typed above.</span>
            </div>
            {pushTestResult ? <p className="mt-2 text-xs text-zinc-300">{pushTestResult}</p> : null}
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.settings}</h3>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <label className="text-zinc-300">Business name<input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Logo URL<input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Brand colors<input value={brandColors} onChange={(e) => setBrandColors(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Payment provider<input value={paymentProvider} onChange={(e) => setPaymentProvider(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Email from<input value={emailFrom} onChange={(e) => setEmailFrom(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Social links<input value={socialLinks} onChange={(e) => setSocialLinks(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300 sm:col-span-2">SEO defaults<textarea value={seoDefaults} onChange={(e) => setSeoDefaults(e.target.value)} className="vl-input mt-1 min-h-16 w-full px-3 py-2" /></label>
              <label className="flex items-center gap-2 text-zinc-300 sm:col-span-2"><input type="checkbox" checked={maintenanceMode} onChange={(e) => setMaintenanceMode(e.target.checked)} /> Enable maintenance mode</label>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.security}</h3>
            <div className="mt-3 space-y-3 text-sm">
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={require2fa} onChange={(e) => setRequire2fa(e.target.checked)} /> Require 2FA for admins</label>
              <label className="block text-zinc-300">Suspicious activity alerts email<input value={suspiciousAlertsEmail} onChange={(e) => setSuspiciousAlertsEmail(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Backup schedule<select value={backupSchedule} onChange={(e) => setBackupSchedule(e.target.value)} className="vl-input mt-1 w-full px-3 py-2"><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
              <label className="block text-zinc-300">Role policy<textarea value={rolePolicy} onChange={(e) => setRolePolicy(e.target.value)} className="vl-input mt-1 min-h-16 w-full px-3 py-2" /></label>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Referral Program</h3>
            <p className="mt-2 text-xs text-zinc-400">
              Three separate rates. What an ambassador saves on their OWN order, what their
              customers save with their code, and what the ambassador EARNS are independent —
              changing one never changes another. Per-ambassador commission rates are set on the
              Partners page.
            </p>

            {/* What the rates actually resolve to, from the same function checkout and the
                approval email use. An empty input box above can mean either "nothing stored,
                using the default" or "stored as blank" — this line says which, so a rate that
                looks wrong can be diagnosed without opening the database. */}
            {referralEffective ? (
              <dl className="mt-3 space-y-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs">
                <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">In force right now</p>
                {[
                  { label: "Ambassador personal discount (their own orders)", value: referralEffective.personalDiscountPercent, source: referralEffective.personalDiscountSource },
                  { label: "Customer referral discount (their code)", value: referralEffective.discountPercent, source: referralEffective.discountSource },
                  { label: "Base commission (what they earn)", value: referralEffective.defaultCommissionPercent, source: referralEffective.defaultCommissionSource },
                ].map((row) => (
                  <div key={row.label} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <dt className="text-zinc-400">{row.label}</dt>
                    <dd className="font-semibold text-white">
                      {row.value}%
                      <span className={`ml-2 font-normal ${row.source === "stored" ? "text-amber-300" : "text-zinc-500"}`}>
                        {row.source === "stored" ? "saved value" : "using the default"}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="mt-3 space-y-3 text-sm">
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={referralEnabled} onChange={(e) => setReferralEnabled(e.target.checked)} /> Referral program enabled</label>
              {/* WHY THIS WARNING EXISTS, AND WHAT IT IS CAREFUL NOT TO SAY.
                  Turning the program off does not just stop NEW codes: every
                  link already shared keeps sending shoppers, and each of them
                  now checks out at full price with no attribution, so the
                  ambassador earns nothing on a sale she generated. It used to
                  be worse — the order was refused outright at the pay button —
                  and the cart now drops the code instead, but "the customer
                  quietly loses the discount you promised them" is still the
                  consequence an operator needs to see before ticking this.
                  The pause switch below is almost always the intended action,
                  so it is named here rather than left to be discovered. */}
              {!referralEnabled ? (
                <p className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-xs leading-5 text-amber-200/90">
                  <strong className="font-semibold">Every referral link you have already shared stops giving a discount.</strong>{" "}
                  Those links keep working and keep sending shoppers, but the code is dropped from their cart: they
                  pay full price, and the ambassador earns nothing on a sale she sent you. Nobody is blocked from
                  checking out. Ambassadors still get their own personal discount while this is off.
                  <br />
                  To stop paying new commissions while your ambassadors&apos; customers keep their discount, use{" "}
                  <span className="font-semibold">Pause new commissions</span> below instead.
                </p>
              ) : (
                <p className="text-xs leading-5 text-zinc-500">
                  Turning this off drops the code from the cart of everyone already holding a referral link — they pay
                  full price and the ambassador earns nothing on the sale. To stop paying commissions while their
                  customers keep the discount, use <span className="text-zinc-400">Pause new commissions</span> below.
                </p>
              )}
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={referralCommissionsPaused} onChange={(e) => setReferralCommissionsPaused(e.target.checked)} /> Pause new commissions (codes still give the customer discount)</label>
              <label className="block text-zinc-300">Ambassador personal discount (% off their own orders)<input value={referralPersonalDiscount} onChange={(e) => setReferralPersonalDiscount(e.target.value)} placeholder="20" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Customer referral discount (% off for shoppers using an ambassador&apos;s code)<input value={referralDiscount} onChange={(e) => setReferralDiscount(e.target.value)} placeholder="10" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="block text-zinc-300">Default commission rate (% when an ambassador has no custom rate)<input value={referralDefaultCommission} onChange={(e) => setReferralDefaultCommission(e.target.value)} placeholder="10" className="vl-input mt-1 w-full px-3 py-2" /></label>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Coupons</h3>
            <div className="mt-3 space-y-3 text-sm">
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={couponsEnabled} onChange={(e) => setCouponsEnabled(e.target.checked)} /> Coupons enabled site-wide</label>
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={couponAllowStacking} onChange={(e) => setCouponAllowStacking(e.target.checked)} /> Allow coupons to stack with referral codes &amp; Buy 3 Get 1</label>
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={bundleStacking} onChange={(e) => setBundleStacking(e.target.checked)} /> Allow Bundle &amp; Save (multi-vial) pricing to stack with percentage discounts</label>
              <p className="text-xs text-zinc-500">
                With both stacking boxes OFF (recommended), every order gets exactly ONE discount — membership, promo code, ambassador code, bulk savings, Buy&nbsp;3&nbsp;Get&nbsp;1, or Bundle&nbsp;&amp;&nbsp;Save pricing — whichever saves the customer the most. Ambassadors still earn commission whenever their code is valid on the order, even when the customer&apos;s membership discount was larger.
              </p>
              <p className="text-xs text-zinc-500">When stacking is off (default), a coupon can&apos;t combine with an ambassador code or Buy 3 Get 1.</p>
            </div>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Profit Protection</h3>
            <p className="mt-2 text-xs text-zinc-400">By default no order can ever finalize at a loss (profit stays at or above $0). Set a minimum margin or minimum profit here only if you want a buffer beyond break-even. These figures also drive the net-profit reports: worst-case vial cost defaults to $33, the processor fee to 8%, and the shipping-cost estimate to $6 (replaced per-order by the exact label cost once an order ships).</p>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <label className="text-zinc-300">Minimum margin (%)<input value={profitMinPercent} onChange={(e) => setProfitMinPercent(e.target.value)} placeholder="0" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Minimum profit ($)<input value={profitMinDollars} onChange={(e) => setProfitMinDollars(e.target.value)} placeholder="0" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Worst-case unit cost ($, when a product has no cost set)<input value={profitWorstCaseCost} onChange={(e) => setProfitWorstCaseCost(e.target.value)} placeholder="33" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Payment processor fee (%)
                <input value={profitProcessingFee} onChange={(e) => setProfitProcessingFee(e.target.value)} placeholder="8" className="vl-input mt-1 w-full px-3 py-2" />
                <span className="mt-1 block text-xs text-zinc-500">
                  {describeEffectiveRate(profitProcessingFee, PROCESSING_FEE_DEFAULT_PERCENT)}
                  {" · this fee is modelled, not a settled processor charge."}
                </span>
              </label>
              <label className="text-zinc-300">Shipping cost estimate ($ per order, pre-ship)<input value={profitShippingEstimate} onChange={(e) => setProfitShippingEstimate(e.target.value)} placeholder="6" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Processor fee charged on sales tax?
                <select value={profitFeeIncludesTax ? "yes" : "no"} onChange={(e) => setProfitFeeIncludesTax(e.target.value === "yes")} className="vl-input mt-1 w-full px-3 py-2">
                  <option value="yes">Yes — fee applies to the full total (incl. tax)</option>
                  <option value="no">No — fee excludes collected sales tax</option>
                </select>
              </label>
              <label className="text-zinc-300">Count collected sales tax as profit?
                <select value={profitCountTax ? "yes" : "no"} onChange={(e) => setProfitCountTax(e.target.value === "yes")} className="vl-input mt-1 w-full px-3 py-2">
                  <option value="yes">Yes — I keep the sales tax (counted as profit)</option>
                  <option value="no">No — tax is remitted to the state (not profit)</option>
                </select>
              </label>
            </div>
          </section>
        </div>

        {message ? <p className="mt-4 text-sm text-zinc-300">{message}</p> : null}
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="vl-panel-soft rounded-2xl p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Customers, Inventory, Analytics</h3>
          <p className="mt-2 text-sm text-zinc-400">Use these modules for customer history, low-stock visibility, and sales insights. Additional controls can be layered into this center without code changes.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/admin/orders" className="vl-btn-secondary px-4 py-2 text-xs">Orders</Link>
            <Link href="/admin/inventory" className="vl-btn-secondary px-4 py-2 text-xs">Inventory</Link>
            <Link href="/admin/partners" className="vl-btn-secondary px-4 py-2 text-xs">Partner Analytics</Link>
          </div>
        </div>

        <div className="vl-panel-soft rounded-2xl p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Safety Guardrails</h3>
          <ul className="mt-2 space-y-2 text-sm text-zinc-400">
            <li>Destructive changes in product management require confirmation prompts.</li>
            <li>Admin actions and control changes are logged in audit storage.</li>
            <li>Live sync listens to backend events for immediate control panel refresh.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}