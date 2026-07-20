"use client";

import { useState } from "react";
import type { EmailAdminSettings } from "@/lib/email/settings";
import type { PaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import type { FulfillmentAdminSettings } from "@/lib/fulfillment/config";
import type { BusinessSettings, WelcomeOffer } from "@/lib/admin-control";

function Labeled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-zinc-400">
      {label}
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function AdminSettingsClient({
  email,
  processor,
  fulfillment,
  business,
  welcomeOffer,
}: {
  email: EmailAdminSettings;
  processor: PaymentProcessorAdminSettings;
  fulfillment: FulfillmentAdminSettings;
  business: BusinessSettings;
  welcomeOffer: WelcomeOffer;
}) {
  // Email state
  const [enabled, setEnabled] = useState(email.enabled);
  const [provider, setProvider] = useState(email.provider);
  const [from, setFrom] = useState(email.from);
  const [smtpHost, setSmtpHost] = useState(email.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(email.smtp.port));
  const [smtpSecure, setSmtpSecure] = useState(email.smtp.secure);
  const [smtpUser, setSmtpUser] = useState(email.smtp.user);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [resendKey, setResendKey] = useState("");

  // Processor state
  const [procEnabled, setProcEnabled] = useState(processor.enabled);
  const [procProvider, setProcProvider] = useState(processor.provider);
  const [procDisplay, setProcDisplay] = useState(processor.displayName);
  const [procPublishable, setProcPublishable] = useState(processor.publishableKey);
  const [procSecret, setProcSecret] = useState("");
  const [procWebhook, setProcWebhook] = useState("");

  // 3PL fulfillment state
  const [fEnabled, setFEnabled] = useState(fulfillment.enabled);
  const [fAuto, setFAuto] = useState(fulfillment.autoTransmit);
  const [fMode, setFMode] = useState(fulfillment.mode);
  const [fProvider, setFProvider] = useState(fulfillment.providerName);
  const [fBaseUrl, setFBaseUrl] = useState(fulfillment.apiBaseUrl);
  const [fApiKey, setFApiKey] = useState("");
  const [fWebhook, setFWebhook] = useState("");
  const [fPayoutModel, setFPayoutModel] = useState(fulfillment.payoutModel);
  const [fPayoutRate, setFPayoutRate] = useState(String(fulfillment.payoutRate));

  // Business info state
  const [supportEmail, setSupportEmail] = useState(business.supportEmail);
  const [businessName, setBusinessName] = useState(business.businessName);

  // Welcome offer state
  const [woEnabled, setWoEnabled] = useState(welcomeOffer.enabled);
  const [woCode, setWoCode] = useState(welcomeOffer.code);
  const [woPercent, setWoPercent] = useState(String(welcomeOffer.percent));
  const [woHeadline, setWoHeadline] = useState(welcomeOffer.headline);
  const [woSubtext, setWoSubtext] = useState(welcomeOffer.subtext);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: {
            enabled,
            provider,
            from,
            smtp_host: smtpHost,
            smtp_port: Number(smtpPort) || 587,
            smtp_secure: smtpSecure,
            smtp_user: smtpUser,
            smtp_password: smtpPassword,
            resend_api_key: resendKey,
          },
          processor: {
            enabled: procEnabled,
            provider: procProvider,
            display_name: procDisplay,
            publishable_key: procPublishable,
            secret_key: procSecret,
            webhook_secret: procWebhook,
          },
          fulfillment: {
            enabled: fEnabled,
            auto_transmit: fAuto,
            mode: fMode,
            provider_name: fProvider,
            api_base_url: fBaseUrl,
            api_key: fApiKey,
            webhook_secret: fWebhook,
            payout_model: fPayoutModel,
            payout_rate: Number(fPayoutRate) || 0,
          },
          business: {
            support_email: supportEmail,
            business_name: businessName,
          },
          welcomeOffer: {
            enabled: woEnabled,
            code: woCode,
            percent: Number(woPercent) || 0,
            headline: woHeadline,
            subtext: woSubtext,
          },
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Save failed");
        setSaving(false);
        return;
      }
      setMessage("Saved. Settings are live.");
      setSmtpPassword("");
      setResendKey("");
      setProcSecret("");
      setProcWebhook("");
      setFApiKey("");
      setFWebhook("");
    } catch {
      setMessage("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTestMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      setTestMessage(json.success ? "Test email sent — check the inbox." : json.error ?? "Test failed.");
    } catch {
      setTestMessage("Test failed.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mt-6 space-y-4">
      {/* Business info */}
      <div className="vl-panel rounded-2xl p-5">
        <h2 className="text-lg font-semibold">Business Info</h2>
        <p className="mt-1 text-sm text-zinc-400">Your support email receives contact-form messages and new-payment alerts. Used across the site and in email footers.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Labeled label="Support / business email"><input value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="you@yourdomain.com" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Business name"><input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Vanta Labs" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
        </div>
      </div>

      {/* Welcome offer */}
      <div className="vl-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Welcome Offer (first-order discount)</h2>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${woEnabled ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-white/20 bg-white/5 text-zinc-300"}`}>{woEnabled ? "Live" : "Off"}</span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">Shows a banner to new visitors with a discount code that works instantly at checkout — no coupon to create.</p>
        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={woEnabled} onChange={(e) => setWoEnabled(e.target.checked)} className="h-4 w-4" />
          Show the welcome banner
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Labeled label="Code"><input value={woCode} onChange={(e) => setWoCode(e.target.value.toUpperCase())} placeholder="WELCOME10" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Discount %"><input type="number" min={0} max={100} value={woPercent} onChange={(e) => setWoPercent(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Headline"><input value={woHeadline} onChange={(e) => setWoHeadline(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Subtext"><input value={woSubtext} onChange={(e) => setWoSubtext(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
        </div>
      </div>

      {/* Email */}
      <div className="vl-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Transactional Email</h2>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${email.ready && enabled ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-amber-300/40 bg-amber-300/10 text-amber-200"}`}>
            {enabled ? (email.ready ? "Ready" : "Enabled — needs credentials") : "Disabled"}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Powers order confirmations, payment received/approved/rejected, shipping updates, password resets, account
          verification, and ambassador emails. Off until you enable it and add credentials.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4" />
          Enable email sending
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Labeled label="Provider">
            <select value={provider} onChange={(e) => setProvider(e.target.value as EmailAdminSettings["provider"])} className="vl-input mt-1 w-full px-3 py-2 text-sm">
              <option value="smtp">SMTP (incl. AWS SES, Gmail, Mailgun)</option>
              <option value="resend">Resend</option>
            </select>
          </Labeled>
          <Labeled label="From address" hint="e.g. Vanta Labs &lt;support@yourdomain.com&gt;">
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="support@yourdomain.com" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </Labeled>
        </div>

        {provider === "smtp" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Labeled label="SMTP host"><input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.provider.com" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
            <Labeled label="SMTP port"><input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
            <Labeled label="SMTP username"><input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
            <Labeled label="SMTP password" hint={email.smtp.passwordSet ? "A password is saved. Leave blank to keep it." : "Not set."}>
              <input type="password" value={smtpPassword} onChange={(e) => setSmtpPassword(e.target.value)} placeholder="••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </Labeled>
            <label className="flex items-center gap-2 text-sm text-zinc-300 sm:col-span-2">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} className="h-4 w-4" />
              Use TLS/SSL (port 465)
            </label>
          </div>
        ) : (
          <div className="mt-3">
            <Labeled label="Resend API key" hint={email.resend.apiKeySet ? "A key is saved. Leave blank to keep it." : "Not set."}>
              <input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </Labeled>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@email.com" className="vl-input w-56 px-3 py-2 text-sm" />
          <button type="button" disabled={testing} onClick={sendTest} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50">{testing ? "Sending…" : "Send test email"}</button>
          {testMessage ? <span className="text-xs text-zinc-300">{testMessage}</span> : null}
        </div>
      </div>

      {/* Payment processor */}
      <div className="vl-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Card Payment Processor</h2>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${procEnabled ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-white/20 bg-white/5 text-zinc-300"}`}>
            {procEnabled ? "Enabled" : "Not connected"}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Store your card processor keys here to connect later. The card checkout remains a safe placeholder until a
          processor integration is wired to these values.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={procEnabled} onChange={(e) => setProcEnabled(e.target.checked)} className="h-4 w-4" />
          Mark processor as connected
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Labeled label="Provider"><input value={procProvider} onChange={(e) => setProcProvider(e.target.value)} placeholder="stripe" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Display label (checkout)"><input value={procDisplay} onChange={(e) => setProcDisplay(e.target.value)} placeholder="Credit / Debit Card" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Publishable key" hint="Public — safe to expose to the browser."><input value={procPublishable} onChange={(e) => setProcPublishable(e.target.value)} placeholder="pk_live_…" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Secret key" hint={processor.secretKeySet ? "A key is saved. Leave blank to keep it." : "Not set."}><input type="password" value={procSecret} onChange={(e) => setProcSecret(e.target.value)} placeholder="sk_live_…" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          <Labeled label="Webhook signing secret" hint={processor.webhookSecretSet ? "A secret is saved. Leave blank to keep it." : "Not set."}><input type="password" value={procWebhook} onChange={(e) => setProcWebhook(e.target.value)} placeholder="whsec_…" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
        </div>
      </div>

      {/* 3PL fulfillment */}
      <div className="vl-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">3PL / Fulfillment</h2>
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${fEnabled ? (fulfillment.ready ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-amber-300/40 bg-amber-300/10 text-amber-200") : "border-white/20 bg-white/5 text-zinc-300"}`}>
            {fEnabled ? (fulfillment.ready ? "Connected" : "Enabled — needs credentials") : "Disabled"}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Paid &amp; verified orders auto-transmit to your 3PL. In <strong>Manual</strong> mode nothing is sent — orders are
          queued and payout reports generated. In <strong>Generic REST</strong> mode, enter your 3PL&apos;s API base URL and
          key. Switching providers later is just new credentials.
        </p>

        <div className="mt-4 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={fEnabled} onChange={(e) => setFEnabled(e.target.checked)} className="h-4 w-4" />
            Enable fulfillment
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input type="checkbox" checked={fAuto} onChange={(e) => setFAuto(e.target.checked)} className="h-4 w-4" />
            Auto-transmit paid orders
          </label>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Labeled label="Mode">
            <select value={fMode} onChange={(e) => setFMode(e.target.value as FulfillmentAdminSettings["mode"])} className="vl-input mt-1 w-full px-3 py-2 text-sm">
              <option value="manual">Manual (reports / invoices, no API)</option>
              <option value="generic_rest">Generic REST API</option>
            </select>
          </Labeled>
          <Labeled label="Provider name (label)"><input value={fProvider} onChange={(e) => setFProvider(e.target.value)} placeholder="my-3pl" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
          {fMode === "generic_rest" ? (
            <>
              <Labeled label="API base URL" hint="Orders are POSTed to {base}/orders."><input value={fBaseUrl} onChange={(e) => setFBaseUrl(e.target.value)} placeholder="https://api.your3pl.com/v1" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
              <Labeled label="API key" hint={fulfillment.apiKeySet ? "A key is saved. Leave blank to keep it." : "Not set."}><input type="password" value={fApiKey} onChange={(e) => setFApiKey(e.target.value)} placeholder="••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
              <Labeled label="Inbound webhook secret" hint={fulfillment.webhookSecretSet ? "A secret is saved. Leave blank to keep it. Point the 3PL webhook at /api/webhooks/fulfillment." : "Point the 3PL webhook at /api/webhooks/fulfillment."}><input type="password" value={fWebhook} onChange={(e) => setFWebhook(e.target.value)} placeholder="••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" /></Labeled>
            </>
          ) : null}
        </div>

        <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
          <Labeled label="Payout model" hint="What you owe the 3PL per order.">
            <select value={fPayoutModel} onChange={(e) => setFPayoutModel(e.target.value as FulfillmentAdminSettings["payoutModel"])} className="vl-input mt-1 w-full px-3 py-2 text-sm">
              <option value="per_unit">Fixed $ per vial/unit</option>
              <option value="percent">Percentage of order total</option>
            </select>
          </Labeled>
          <Labeled label={fPayoutModel === "percent" ? "Rate (% of order)" : "Rate ($ per vial)"}>
            <input type="number" min={0} step="0.01" value={fPayoutRate} onChange={(e) => setFPayoutRate(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </Labeled>
        </div>
      </div>

      <div className="sticky bottom-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/90 p-4 backdrop-blur">
        <button type="button" disabled={saving} onClick={save} className="vl-btn-primary px-5 py-2.5 text-sm disabled:opacity-50">{saving ? "Saving…" : "Save settings"}</button>
        {message ? <span className="text-sm text-zinc-300">{message}</span> : null}
      </div>
    </div>
  );
}
