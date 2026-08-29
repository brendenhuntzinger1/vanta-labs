"use client";

import { useState } from "react";
import type { EmailAdminSettings } from "@/lib/email/settings";
import type { PaymentProcessorAdminSettings } from "@/lib/payment-processor-config";
import type { FulfillmentAdminSettings } from "@/lib/fulfillment-settings";
import type { InventoryReadiness } from "@/lib/admin-inventory";
import type { PackagePresetRecord } from "@/lib/shippo/packages";
import type { ShippingAddress } from "@/lib/shipping-origin";
import type { BusinessSettings, WelcomeOffer } from "@/lib/admin-control";
import { AdminShippingPackagesClient } from "@/components/admin-shipping-packages-client";
import { AdminShippingOriginClient } from "@/components/admin-shipping-origin-client";

function Labeled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-zinc-400">
      {label}
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span> : null}
    </label>
  );
}

/**
 * A fingerprint of the RISK a readiness check describes, not of the check
 * itself.
 *
 * The operator's confirmation has to survive the re-check that happens at save
 * time — keying it on the timestamp would invalidate every confirmation the
 * instant it was re-verified, and the save could never complete. Keying it on
 * the numbers means the confirmation stands while the situation is unchanged
 * and is withdrawn the moment it is not, which is exactly what was consented
 * to.
 */
function riskSignature(readiness: InventoryReadiness): string {
  return [readiness.isEffectivelyEmpty, readiness.totalLines, readiness.stockedLines, readiness.blockedLines].join("|");
}

export function AdminSettingsClient({
  email,
  processor,
  fulfillment,
  business,
  welcomeOffer,
  siteUrl,
  inventoryReadiness,
  packages,
  shippingOrigin,
  shippingReturnAddress,
  usesSeparateReturnAddress,
  shippingOriginMissing,
  canManage,
}: {
  email: EmailAdminSettings;
  processor: PaymentProcessorAdminSettings;
  fulfillment: FulfillmentAdminSettings;
  business: BusinessSettings;
  welcomeOffer: WelcomeOffer;
  siteUrl: string;
  /** Server-measured at page render. Re-measured before enforcement is armed. */
  inventoryReadiness: InventoryReadiness | null;
  packages: PackagePresetRecord[];
  shippingOrigin: ShippingAddress;
  shippingReturnAddress: ShippingAddress;
  usesSeparateReturnAddress: boolean;
  shippingOriginMissing: string[];
  canManage: boolean;
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
  const [sendgridKey, setSendgridKey] = useState("");
  const [postalAddress, setPostalAddress] = useState(email.marketingPostalAddress ?? "");
  const [marketingFrom, setMarketingFrom] = useState(email.marketingFrom ?? "");

  // Processor state
  const [procEnabled, setProcEnabled] = useState(processor.enabled);
  const [procProvider, setProcProvider] = useState(processor.provider);
  const [procDisplay, setProcDisplay] = useState(processor.displayName);
  const [procPublishable, setProcPublishable] = useState(processor.publishableKey);
  const [procSecret, setProcSecret] = useState("");
  const [procWebhook, setProcWebhook] = useState("");

  // In-house fulfillment state. The only writable setting is whether stock
  // levels gate sales — there are no provider credentials to enter any more.
  const [fInventoryTracking, setFInventoryTracking] = useState(fulfillment.inventoryTrackingEnabled);

  // ----------------------------------------------------------------------
  // Inventory enforcement guard.
  //
  // Arming this flag makes stored stock levels start blocking sales the moment
  // it saves. On a catalog whose quantities were never populated — the likely
  // state, since nothing has been enforcing them — that empties the storefront
  // instantly and silently. So the switch is checked against the DATABASE, not
  // against this page's copy of it: the tab may have been open for an hour, or
  // a second admin may have been entering counts in another window.
  //
  // `savedInventoryTracking` tracks what is actually persisted, so re-saving
  // unrelated settings while enforcement is already on doesn't re-interrogate
  // the operator about a decision they already made.
  // ----------------------------------------------------------------------
  const [savedInventoryTracking, setSavedInventoryTracking] = useState(fulfillment.inventoryTrackingEnabled);
  const [readiness, setReadiness] = useState<InventoryReadiness | null>(inventoryReadiness);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [confirmedSignature, setConfirmedSignature] = useState<string | null>(null);

  const isArmingEnforcement = fInventoryTracking && !savedInventoryTracking;
  const enforcementRisky = isArmingEnforcement && readiness !== null && readiness.isEffectivelyEmpty;
  const enforcementConfirmed = readiness !== null && confirmedSignature === riskSignature(readiness);

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

  /** Ask the server what the inventory actually looks like right now. */
  const fetchReadiness = async (): Promise<InventoryReadiness | null> => {
    try {
      const res = await fetch("/api/admin/inventory?summary=1", { cache: "no-store" });
      const json = (await res.json()) as { success: boolean; readiness?: InventoryReadiness };
      return json.success && json.readiness ? json.readiness : null;
    } catch {
      return null;
    }
  };

  const toggleInventoryTracking = async (next: boolean) => {
    setFInventoryTracking(next);
    setMessage(null);

    if (!next) {
      // Switching enforcement OFF only ever makes more things purchasable.
      // Nothing to warn about, and any prior confirmation is now meaningless.
      setConfirmedSignature(null);
      return;
    }

    setCheckingReadiness(true);
    const fresh = await fetchReadiness();
    setCheckingReadiness(false);
    // A failed check leaves the previous figures on screen but withdraws any
    // confirmation, so save() re-checks and refuses rather than arming blind.
    setConfirmedSignature(null);
    if (fresh) {
      setReadiness(fresh);
    }
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);

    // Re-verify against the database immediately before arming enforcement.
    // The check that rendered this page may be minutes or hours old, and this
    // is the one setting on the screen where acting on a stale reading takes
    // the whole catalog off sale.
    if (isArmingEnforcement) {
      const fresh = await fetchReadiness();
      if (!fresh) {
        setMessage("Couldn't check your inventory counts, so enforcement wasn't turned on. Nothing else was saved either — try again.");
        setSaving(false);
        return;
      }
      setReadiness(fresh);

      if (fresh.isEffectivelyEmpty && confirmedSignature !== riskSignature(fresh)) {
        // Either they never confirmed, or the situation changed since they did.
        // Withdraw the stale confirmation so the checkbox re-arms against the
        // numbers now on screen.
        setConfirmedSignature(null);
        setMessage(
          fresh.totalLines === 0
            ? "Nothing was saved. There are no products to enforce stock against yet."
            : `Nothing was saved. ${fresh.zeroQuantityLines} of ${fresh.totalLines} inventory lines are still at zero — tick the confirmation to enable enforcement anyway.`,
        );
        setSaving(false);
        return;
      }
    }

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
            sendgrid_api_key: sendgridKey,
            marketing_postal_address: postalAddress,
            marketing_from: marketingFrom,
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
            inventory_tracking_enabled: fInventoryTracking,
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
      setMessage(
        fInventoryTracking && !savedInventoryTracking
          ? "Saved. Inventory enforcement is live — stock levels now gate the storefront."
          : "Saved. Settings are live.",
      );
      // What's persisted has moved, so the guard shouldn't re-interrogate the
      // operator the next time they save something unrelated.
      setSavedInventoryTracking(fInventoryTracking);
      setConfirmedSignature(null);
      setSmtpPassword("");
      setResendKey("");
      setSendgridKey("");
      setProcSecret("");
      setProcWebhook("");
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
              <option value="sendgrid">SendGrid</option>
            </select>
          </Labeled>
          <Labeled label="From address" hint="e.g. Vanta Labs &lt;support@yourdomain.com&gt;">
            <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="support@yourdomain.com" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </Labeled>
        </div>

        <div className="mt-3">
          <Labeled
            label="Marketing From address (optional)"
            hint="Leave blank to send marketing from the address above. Setting a separate subdomain (e.g. news@mail.yourdomain.com) keeps campaign complaints from damaging the reputation of the domain that sends receipts and password resets."
          >
            <input
              value={marketingFrom}
              onChange={(e) => setMarketingFrom(e.target.value)}
              placeholder="Vanta Labs <news@mail.yourdomain.com>"
              className="vl-input mt-1 w-full px-3 py-2 text-sm"
            />
          </Labeled>
          {/* Standing risk, surfaced rather than left to be discovered after a
              campaign has already cost the receipts domain its reputation. Not
              styled as an error: sending this way works, it is just a decision
              that should be made deliberately (audit E5). */}
          {email.marketingSharesTransactionalDomain ? (
            <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs leading-relaxed text-amber-200">
              Campaigns are currently sent from <strong>{email.effectiveMarketingFrom || "the transactional address"}</strong> — the
              same address as receipts and password resets. Spam complaints from a campaign will land on that
              domain&apos;s reputation, and the first mail to suffer is the mail customers need. Set a separate
              marketing subdomain above once it is verified with your provider.
            </p>
          ) : null}
        </div>

        <div className="mt-3">
          <Labeled
            label="Mailing address (marketing email)"
            hint="Printed in the footer of promotional email only — US law (CAN-SPAM) requires a real postal address in every commercial message. A PO Box is fine. Receipts and shipping notices are exempt and are unaffected. Campaigns cannot send while this is blank."
          >
            <textarea
              rows={3}
              value={postalAddress}
              onChange={(e) => setPostalAddress(e.target.value)}
              placeholder={"Vanta Labs\nPO Box 1234\nDenver, CO 80202"}
              className="vl-input mt-1 w-full px-3 py-2 text-sm"
            />
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
        ) : provider === "resend" ? (
          <div className="mt-3">
            <Labeled label="Resend API key" hint={email.resend.apiKeySet ? "A key is saved. Leave blank to keep it." : "Not set."}>
              <input type="password" value={resendKey} onChange={(e) => setResendKey(e.target.value)} placeholder="re_••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </Labeled>
          </div>
        ) : (
          <div className="mt-3">
            <Labeled label="SendGrid API key" hint={email.sendgrid.apiKeySet ? "A key is saved. Leave blank to keep it." : "Not set."}>
              <input type="password" value={sendgridKey} onChange={(e) => setSendgridKey(e.target.value)} placeholder="SG.••••••••" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </Labeled>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@email.com" className="vl-input w-full px-3 py-2 text-sm sm:w-56" />
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

      {/* Fulfillment (in-house) */}
      <div className="vl-panel rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Fulfillment &amp; shipping</h2>
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
              !fulfillment.shippo.configured
                ? "border-white/20 bg-white/5 text-zinc-300"
                : fulfillment.shippo.mode === "live"
                  ? "border-rose-300/40 bg-rose-300/10 text-rose-200"
                  : "border-amber-300/40 bg-amber-300/10 text-amber-200"
            }`}
          >
            Shippo: {fulfillment.shippo.label}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-400">
          Orders are fulfilled in-house. Paid orders appear in the fulfillment queue, where you buy a
          Shippo label and print it. Nothing is transmitted to any outside fulfillment provider.
        </p>

        {fulfillment.shippo.configured ? (
          fulfillment.shippo.mode === "live" ? (
            <p className="mt-3 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
              <strong>LIVE mode.</strong> Buying a label charges real postage to your Shippo account.
            </p>
          ) : (
            <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
              <strong>TEST mode.</strong> Labels are simulated and carry no real postage — they are not
              valid for shipping. Swap <code>SHIPPO_API_TOKEN</code> for a live token when you are ready.
            </p>
          )
        ) : (
          <p className="mt-3 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-[13px] text-zinc-300">
            <code>SHIPPO_API_TOKEN</code> is not set on the server, so rates and labels are unavailable.
            Add it in your hosting environment — it is never entered or stored here.
          </p>
        )}

        <div className="mt-4 border-t border-white/10 pt-4">
          <label className="flex items-start gap-3 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={fInventoryTracking}
              onChange={(e) => void toggleInventoryTracking(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              Enforce inventory on the storefront
              <span className="mt-1 block text-[12px] font-normal text-zinc-500">
                When off, every product stays purchasable regardless of stock. When on, a stored
                &quot;Out of Stock&quot; or a zero quantity blocks the sale. Populate real counts in
                Inventory before turning this on, or products may go unpurchasable immediately.
              </span>
            </span>
          </label>

          {checkingReadiness ? (
            <p className="mt-3 text-[12px] text-zinc-500">Checking your current stock counts…</p>
          ) : null}

          {/* The catalog is not populated and enforcement is about to be armed.
              This is the case that empties the storefront, so it blocks the
              save until it is explicitly acknowledged. */}
          {enforcementRisky && readiness ? (
            <div className="mt-3 rounded-xl border border-rose-300/40 bg-rose-300/10 p-4 text-[13px] text-rose-50">
              <p className="font-semibold">
                {readiness.totalLines === 0
                  ? "There is no inventory to enforce."
                  : "Your inventory is empty — this will pull products off the storefront."}
              </p>

              {readiness.totalLines === 0 ? (
                <p className="mt-2 text-rose-100/90">
                  No sellable product lines were found, so turning this on can only block sales. Add products first.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-rose-100/90">
                    <strong>{readiness.zeroQuantityLines} of {readiness.totalLines}</strong> product lines are still at
                    zero{readiness.stockedLines > 0 ? `, and only ${readiness.stockedLines} ${readiness.stockedLines === 1 ? "has" : "have"} a real count` : " — none has a real count"}.
                    The moment you save this, every one of them stops being purchasable.
                  </p>
                  {readiness.blockedLines > 0 ? (
                    <p className="mt-2 text-rose-100/90">
                      <strong>{readiness.blockedLines}</strong> {readiness.blockedLines === 1 ? "line is" : "lines are"} marked
                      &quot;Out of Stock&quot; and would disappear immediately
                      {readiness.sampleBlockedNames.length > 0 ? (
                        <>
                          {" "}— including {readiness.sampleBlockedNames.join(", ")}
                          {readiness.blockedLines > readiness.sampleBlockedNames.length ? ", and others" : ""}
                        </>
                      ) : null}
                      .
                    </p>
                  ) : null}
                  <p className="mt-2 text-rose-100/90">
                    Enter your real counts in <a href="/admin/inventory" className="underline underline-offset-2">Inventory</a> first,
                    then come back and switch this on.
                  </p>
                </>
              )}

              <label className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200/30 bg-rose-200/10 p-3 font-medium text-rose-50">
                <input
                  type="checkbox"
                  checked={enforcementConfirmed}
                  onChange={(e) => setConfirmedSignature(e.target.checked && readiness ? riskSignature(readiness) : null)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  I understand this takes those products off sale immediately, and I want to enforce inventory anyway.
                </span>
              </label>

              <p className="mt-2 text-[11px] text-rose-100/70">
                Counts read from the database{readiness.checkedAt ? ` at ${new Date(readiness.checkedAt).toLocaleTimeString()}` : ""} and
                re-checked when you save.
              </p>
            </div>
          ) : null}

          {/* Enforcement is safe to arm, but some lines are genuinely sold out.
              Worth stating plainly; not worth blocking on. */}
          {isArmingEnforcement && readiness && !readiness.isEffectivelyEmpty && readiness.blockedLines > 0 ? (
            <p className="mt-3 rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
              {readiness.blockedLines} of {readiness.totalLines} lines are marked &quot;Out of Stock&quot; and will stop
              being purchasable when you save. The other {readiness.totalLines - readiness.blockedLines} are unaffected.
            </p>
          ) : null}

          {isArmingEnforcement && readiness && !readiness.isEffectivelyEmpty && readiness.blockedLines === 0 ? (
            <p className="mt-3 rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-3 py-2 text-[13px] text-emerald-100">
              All {readiness.totalLines} product lines have a real count and none is out of stock. Nothing will disappear
              from the storefront when you save.
            </p>
          ) : null}
        </div>
      </div>

      {/* Packages and the ship-from address are both inputs to every Shippo
          rate request, so they live next to the fulfillment settings above
          rather than on a screen of their own. */}
      <AdminShippingPackagesClient initialPackages={packages} canManage={canManage} />

      <AdminShippingOriginClient
        initialOrigin={shippingOrigin}
        initialReturn={shippingReturnAddress}
        initialUsesSeparateReturn={usesSeparateReturnAddress}
        initialOriginMissing={shippingOriginMissing}
      />

      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/90 p-4 backdrop-blur">
        <button type="button" disabled={saving} onClick={save} className="vl-btn-primary px-5 py-2.5 text-sm disabled:opacity-50">{saving ? "Saving…" : "Save settings"}</button>
        {message ? <span className="text-sm text-zinc-300">{message}</span> : null}
        {!message && enforcementRisky && !enforcementConfirmed ? (
          <span className="text-sm text-rose-200">
            Saving is blocked until you confirm the inventory warning above, or untick enforcement.
          </span>
        ) : null}
      </div>
    </div>
  );
}
