"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type ControlSnapshot = Record<string, Record<string, unknown>>;

type SectionKey = "homepage" | "promotions" | "shipping" | "content" | "settings" | "security";

const SECTION_LABELS: Record<SectionKey, string> = {
  homepage: "Homepage",
  promotions: "Promotions",
  shipping: "Shipping",
  content: "Content",
  settings: "Website Settings",
  security: "Security",
};

function parseCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function AdminControlCenterClient() {
  const [saving, setSaving] = useState(false);
  const [quickSaving, setQuickSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [homepageHeroHeadline, setHomepageHeroHeadline] = useState("");
  const [homepageHeroSubheadline, setHomepageHeroSubheadline] = useState("");
  const [homepageTickerItems, setHomepageTickerItems] = useState("");
  const [homepagePromoPills, setHomepagePromoPills] = useState("");
  const [homepageFeaturedSlugs, setHomepageFeaturedSlugs] = useState("");

  const [promoBuy3Get1Enabled, setPromoBuy3Get1Enabled] = useState(false);
  const [promoBuy2Get1HalfEnabled, setPromoBuy2Get1HalfEnabled] = useState(false);
  const [promoFreeShippingThreshold, setPromoFreeShippingThreshold] = useState("");
  const [promoAnnouncement, setPromoAnnouncement] = useState("");

  const [shippingFlatRate, setShippingFlatRate] = useState("");
  const [shippingFreeThreshold, setShippingFreeThreshold] = useState("");
  const [shippingTaxRate, setShippingTaxRate] = useState("");
  const [shippingServiceFee, setShippingServiceFee] = useState("");

  const [contentFaq, setContentFaq] = useState("");
  const [contentPolicies, setContentPolicies] = useState("");
  const [contentContactEmail, setContentContactEmail] = useState("");
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

  const loadSnapshot = async () => {
    const res = await fetch("/api/admin/control", { cache: "no-store" });
    const json = await res.json() as { success: boolean; snapshot?: ControlSnapshot; error?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Unable to load settings");
      return;
    }

    const next = json.snapshot ?? {};

    const homepage = next.homepage ?? {};
    setHomepageHeroHeadline(String(homepage.hero_headline ?? ""));
    setHomepageHeroSubheadline(String(homepage.hero_subheadline ?? ""));
    setHomepageTickerItems(Array.isArray(homepage.promo_ticker_items) ? (homepage.promo_ticker_items as string[]).join(", ") : "");
    setHomepagePromoPills(Array.isArray(homepage.promo_pills) ? (homepage.promo_pills as string[]).join(", ") : "");
    setHomepageFeaturedSlugs(Array.isArray(homepage.featured_product_slugs) ? (homepage.featured_product_slugs as string[]).join(", ") : "");

    const promotions = next.promotions ?? {};
    setPromoBuy3Get1Enabled(Boolean(promotions.buy_3_get_1_enabled ?? false));
    setPromoBuy2Get1HalfEnabled(Boolean(promotions.buy_2_get_1_half_enabled ?? false));
    setPromoFreeShippingThreshold(String(promotions.free_shipping_threshold ?? ""));
    setPromoAnnouncement(String(promotions.sitewide_announcement ?? ""));

    const shipping = next.shipping ?? {};
    setShippingFlatRate(String(shipping.flat_rate ?? ""));
    setShippingFreeThreshold(String(shipping.free_shipping_threshold ?? ""));
    setShippingTaxRate(String(shipping.tax_rate ?? ""));
    setShippingServiceFee(String(shipping.service_fee ?? ""));

    const content = next.content ?? {};
    setContentFaq(String(content.faq ?? ""));
    setContentPolicies(String(content.policies ?? ""));
    setContentContactEmail(String(content.contact_email ?? ""));
    setContentFooterLinks(String(content.footer_links ?? ""));
    setContentLegalPages(String(content.legal_pages ?? ""));

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
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadSnapshot();
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
    setSaving(true);
    setMessage(null);

    const updates = [
      { section: "homepage", key: "hero_headline", value: homepageHeroHeadline },
      { section: "homepage", key: "hero_subheadline", value: homepageHeroSubheadline },
      { section: "homepage", key: "promo_ticker_items", value: parseCsv(homepageTickerItems) },
      { section: "homepage", key: "promo_pills", value: parseCsv(homepagePromoPills) },
      { section: "homepage", key: "featured_product_slugs", value: parseCsv(homepageFeaturedSlugs) },

      { section: "promotions", key: "buy_3_get_1_enabled", value: promoBuy3Get1Enabled },
      { section: "promotions", key: "buy_2_get_1_half_enabled", value: promoBuy2Get1HalfEnabled },
      { section: "promotions", key: "free_shipping_threshold", value: promoFreeShippingThreshold },
      { section: "promotions", key: "sitewide_announcement", value: promoAnnouncement },

      { section: "shipping", key: "flat_rate", value: shippingFlatRate },
      { section: "shipping", key: "free_shipping_threshold", value: shippingFreeThreshold },
      { section: "shipping", key: "tax_rate", value: shippingTaxRate },
      { section: "shipping", key: "service_fee", value: shippingServiceFee },

      { section: "content", key: "faq", value: contentFaq },
      { section: "content", key: "policies", value: contentPolicies },
      { section: "content", key: "contact_email", value: contentContactEmail },
      { section: "content", key: "footer_links", value: contentFooterLinks },
      { section: "content", key: "legal_pages", value: contentLegalPages },

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
    ];

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

    setMessage("Control center updates saved and synced.");
    setSaving(false);
    void loadSnapshot();
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
            <button type="button" onClick={saveAll} disabled={saving} className="vl-btn-primary vl-focus-ring px-5 py-3 text-sm disabled:opacity-60">
              {saving ? "Saving..." : "Save All Changes"}
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
              <label className="flex items-center gap-2 text-zinc-300 sm:col-span-2"><input type="checkbox" checked={promoBuy2Get1HalfEnabled} onChange={(e) => setPromoBuy2Get1HalfEnabled(e.target.checked)} /> Enable Buy 2 Get 1 (50% Off)</label>
              <label className="text-zinc-300">Free shipping threshold<input value={promoFreeShippingThreshold} onChange={(e) => setPromoFreeShippingThreshold(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" /></label>
            </div>
            <p className="mt-3 text-xs text-zinc-500">
              Coupon codes are managed separately with real redemption tracking — see{" "}
              <Link href="/admin/coupons" className="text-zinc-300 underline hover:text-white">Coupons</Link>.
            </p>
          </section>

          <section className="vl-panel-soft rounded-2xl p-4">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">{SECTION_LABELS.shipping}</h3>
            <p className="mt-2 text-xs text-zinc-400">These apply live at checkout. Leave a field blank to keep the default (domestic flat rate $15, free over $250, 5% service fee, 0% tax).</p>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <label className="text-zinc-300">Domestic flat rate ($)<input value={shippingFlatRate} onChange={(e) => setShippingFlatRate(e.target.value)} placeholder="15" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Free shipping over ($)<input value={shippingFreeThreshold} onChange={(e) => setShippingFreeThreshold(e.target.value)} placeholder="250" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Sales tax rate (%)<input value={shippingTaxRate} onChange={(e) => setShippingTaxRate(e.target.value)} placeholder="0" className="vl-input mt-1 w-full px-3 py-2" /></label>
              <label className="text-zinc-300">Service fee (%)<input value={shippingServiceFee} onChange={(e) => setShippingServiceFee(e.target.value)} placeholder="5" className="vl-input mt-1 w-full px-3 py-2" /></label>
            </div>
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
        </div>

        {message ? <p className="mt-4 text-sm text-zinc-300">{message}</p> : null}
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="vl-panel-soft rounded-2xl p-4">
          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Customers, Inventory, Analytics</h3>
          <p className="mt-2 text-sm text-zinc-400">Use these modules for customer history, low-stock visibility, and sales insights. Additional controls can be layered into this center without code changes.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/admin/orders" className="vl-btn-secondary px-4 py-2 text-xs">Orders</Link>
            <Link href="/admin/products" className="vl-btn-secondary px-4 py-2 text-xs">Inventory</Link>
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