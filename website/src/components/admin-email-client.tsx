"use client";

import { useEffect, useMemo, useState } from "react";
import type { CampaignSummary, EmailDashboard } from "@/lib/admin-email";
import type { AutomationRow } from "@/lib/email/automations";
import { checkCampaignDeliverability } from "@/lib/email/deliverability-check";

type Segment = { value: string; label: string; needsParam?: boolean; hint: string };

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function percent(numerator: number, denominator: number) {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

const EMPTY_FORM = {
  name: "",
  subject: "",
  previewText: "",
  headline: "",
  body: "",
  promoCode: "",
  ctaLabel: "SHOP NOW",
  ctaPath: "/products",
  segment: "all",
  segmentParam: "",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function AdminEmailClient({
  dashboard,
  automations,
  segments,
  categories,
  postalAddressSet,
  emailReady,
  emailEnabled,
}: {
  dashboard: EmailDashboard;
  automations: AutomationRow[];
  segments: Segment[];
  categories: string[];
  // Deliberately three separate flags rather than one "ready" boolean: the
  // banner has to say WHICH of the three things is missing, and a single
  // boolean cannot.
  postalAddressSet: boolean;
  emailReady: boolean;
  emailEnabled: boolean;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [automationDrafts, setAutomationDrafts] = useState(automations);

  const activeSegment = useMemo(
    () => segments.find((segment) => segment.value === form.segment) ?? segments[0],
    [segments, form.segment],
  );

  // Recomputed as the operator types. It is a pure function over the form —
  // no request, no debounce — so the verdict moves with the copy instead of
  // arriving after Send, which is the only moment it would be useless.
  const deliverability = useMemo(
    () =>
      checkCampaignDeliverability({
        subject: form.subject,
        previewText: form.previewText,
        headline: form.headline,
        body: form.body,
        promoCode: form.promoCode,
        ctaLabel: form.ctaLabel,
      }),
    [form.subject, form.previewText, form.headline, form.body, form.promoCode, form.ctaLabel],
  );

  // Live audience size. Debounced because changing a segment with a parameter
  // types one character at a time and each keystroke would otherwise page the
  // orders table.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      // Cleared inside the timer rather than synchronously in the effect body:
      // a synchronous setState here re-renders before paint on every keystroke.
      if (!cancelled) setAudienceCount(null);
      const params = new URLSearchParams({ segment: form.segment });
      if (form.segmentParam) params.set("segmentParam", form.segmentParam);
      fetch(`/api/admin/email/campaigns?${params.toString()}`)
        .then((response) => response.json())
        .then((data) => {
          if (!cancelled && data?.success) setAudienceCount(Number(data.count ?? 0));
        })
        .catch(() => {
          if (!cancelled) setAudienceCount(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.segment, form.segmentParam]);

  const blockedReason = !emailEnabled
    ? "Email sending is turned off in Settings."
    : !emailReady
      ? "The email provider isn't fully configured in Settings."
      : !postalAddressSet
        ? "Add a physical postal address in Settings before sending marketing email — US law (CAN-SPAM) requires it in every commercial message."
        : null;

  /**
   * Run an action so it ALWAYS ends with the UI usable and something on screen.
   *
   * Every handler here used to be a bare async function: `setBusy(true)`, an
   * `await fetch`, `setBusy(false)` at the end. If the fetch threw — a dropped
   * connection, a blocked request, the tab going offline for a second — the
   * rejection escaped, `setBusy(false)` never ran and no message was ever set.
   * The result from the operator's side is that the button goes dead and stays
   * dead: they click Send test, nothing happens, and every click after that
   * does nothing either, with no clue why. That is precisely the report this
   * was written for.
   *
   * `finally` is the whole point — it clears `busy` whether the action
   * succeeded, failed, or threw.
   */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error
          ? `Something went wrong: ${error.message}. Nothing was sent — try again.`
          : "Something went wrong. Nothing was sent — try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function saveCampaign(): Promise<string | null> {
    const url = editingId ? `/api/admin/email/campaigns/${editingId}` : "/api/admin/email/campaigns";
    const response = await fetch(url, {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await response.json().catch(() => null);
    if (!data?.success) {
      setMessage({ tone: "error", text: data?.error ?? "Unable to save this campaign." });
      return null;
    }
    const id = editingId ?? String(data.campaignId);
    setEditingId(id);
    return id;
  }

  async function handleSave() {
    await run(async () => {
      const id = await saveCampaign();
      if (id) setMessage({ tone: "ok", text: "Draft saved." });
    });
  }

  async function handleTest() {
    await run(async () => {
      const id = await saveCampaign();
      if (!id) return;
      const response = await fetch(`/api/admin/email/campaigns/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "test", testEmail }),
      });
      const data = await response.json().catch(() => null);
      setMessage(
        data?.success
          ? { tone: "ok", text: `Test sent to ${testEmail}. If it doesn't arrive, check spam and your email provider's log.` }
          : { tone: "error", text: data?.error ?? `Unable to send the test (HTTP ${response.status}).` },
      );
    });
  }

  async function handleSend(mode: "now" | "schedule") {
    // THE HIGH-RISK GATE IS SEPARATE FROM, AND BEFORE, THE "are you sure"
    // PROMPT — and it applies to a SCHEDULED send too. A campaign queued for
    // Tuesday reaches the same inboxes as one sent now; the only difference is
    // that nobody is watching when it goes. Naming the findings in the prompt
    // is deliberate: "this looks spammy" teaches nothing, while "6 pressure
    // phrases in 17 words" is a sentence the operator can act on.
    if (deliverability.risk === "high") {
      const detail = deliverability.findings
        .filter((finding) => finding.severity === "critical")
        .map((finding) => `• ${finding.message}\n  ${finding.fix}`)
        .join("\n\n");
      const proceed = window.confirm(
        `This campaign is likely to be filtered as spam.\n\n${detail}\n\n` +
          "Sending it anyway also costs the reputation of the domain that carries your receipts, " +
          "password resets and affiliate mail.\n\nSend it regardless?",
      );
      if (!proceed) return;
    }

    if (mode === "now") {
      const audience = audienceCount ?? 0;
      const confirmed = window.confirm(
        `Send "${form.name || "this campaign"}" to ${audience} subscriber${audience === 1 ? "" : "s"}?\n\nThis cannot be undone.`,
      );
      if (!confirmed) return;
    }
    await run(async () => {
    const id = await saveCampaign();
    if (!id) return;

    const response = await fetch(`/api/admin/email/campaigns/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "now" ? { mode: "now" } : { mode: "schedule", scheduledAt: new Date(scheduleAt).toISOString() }),
    });
    const data = await response.json().catch(() => null);

    if (!data?.success) {
      setMessage({ tone: "error", text: data?.error ?? `Unable to send this campaign (HTTP ${response.status}).` });
      return;
    }

    if (mode === "schedule") {
      setMessage({ tone: "ok", text: "Scheduled. The sweep runs every 30 minutes, so it will go out within half an hour of that time." });
    } else if (data.note) {
      setMessage({ tone: "ok", text: String(data.note) });
    } else {
      setMessage({
        tone: "ok",
        text: `Sending to ${data.recipients} subscriber${data.recipients === 1 ? "" : "s"}. ${data.sent} sent so far${data.remaining ? `, ${data.remaining} queued — the rest goes out automatically.` : "."}`,
      });
    }
    // Refresh so the history table reflects the send that just started.
    setTimeout(() => window.location.reload(), 1500);
    });
  }

  function loadIntoComposer(campaign: CampaignSummary) {
    // Only the fields the summary carries; the composer is for drafting a new
    // send, so this is a starting point rather than a full round-trip edit.
    setForm({
      ...EMPTY_FORM,
      name: `${campaign.name} (copy)`,
      subject: campaign.subject,
      segment: campaign.segment,
      segmentParam: campaign.segmentParam ?? "",
    });
    setEditingId(null);
    setMessage({ tone: "ok", text: "Loaded as a new draft. Fill in the headline and message." });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleStop(campaign: CampaignSummary) {
    const confirmed = window.confirm(
      `Stop "${campaign.name}"?\n\n${campaign.sent} email(s) have already been sent and CANNOT be recalled. `
      + `This prevents the remaining ${campaign.pending} from going out.`,
    );
    if (!confirmed) return;
    await run(async () => {
      const response = await fetch(`/api/admin/email/campaigns/${campaign.id}/stop`, { method: "POST" });
      const data = await response.json().catch(() => null);
      setMessage(
        data?.success
          ? { tone: "ok", text: `Stopped. ${data.alreadySent} had already been sent; ${data.stoppedBeforeSending} were prevented.` }
          : { tone: "error", text: data?.error ?? "Unable to stop this campaign." },
      );
      if (data?.success) setTimeout(() => window.location.reload(), 1200);
    });
  }

  async function saveAutomation(row: AutomationRow) {
    await run(async () => {
    const response = await fetch("/api/admin/email/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: row.key,
        enabled: row.enabled,
        delayDays: row.delay_days,
        subject: row.subject,
        headline: row.headline,
        body: row.body,
        promoCode: row.promo_code,
        ctaLabel: row.cta_label,
        ctaPath: row.cta_path,
      }),
    });
    const data = await response.json().catch(() => null);
    setMessage(
      data?.success
        ? { tone: "ok", text: `Saved "${row.key.replace(/_/g, " ")}".` }
        : { tone: "error", text: data?.error ?? "Unable to save this automation." },
    );
    });
  }

  return (
    <div className="space-y-6">
      {blockedReason ? (
        <section className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4">
          <p className="text-sm text-amber-200">{blockedReason}</p>
        </section>
      ) : null}

      {message ? (
        <section
          className={`rounded-2xl border p-4 ${
            message.tone === "ok" ? "border-emerald-400/30 bg-emerald-400/10" : "border-rose-400/30 bg-rose-400/10"
          }`}
        >
          <p className={`text-sm ${message.tone === "ok" ? "text-emerald-200" : "text-rose-200"}`}>{message.text}</p>
        </section>
      ) : null}

      {/* Dashboard ------------------------------------------------------ */}
      <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Overview</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Subscribers" value={String(dashboard.subscribers)} hint="Opted in, not unsubscribed" />
          <Stat label="Emails sent" value={String(dashboard.totals.sent)} />
          <Stat
            label="Open rate"
            value={percent(dashboard.totals.opened, dashboard.totals.sent)}
            hint="Inflated by Apple Mail — trend only"
          />
          <Stat label="Click rate" value={percent(dashboard.totals.clicked, dashboard.totals.sent)} />
          <Stat
            label="Attributed revenue"
            value={money(dashboard.totals.revenue)}
            hint={`${dashboard.totals.orders} order${dashboard.totals.orders === 1 ? "" : "s"}, net of refunds`}
          />
        </div>
      </section>

      {/* Composer ------------------------------------------------------- */}
      <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">{editingId ? "Edit campaign" : "Create campaign"}</h2>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Campaign name</span>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Buy 2 Get 1 Promo"
              />
              <span className="mt-1 block text-[11px] text-zinc-600">Internal only — customers never see this.</span>
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Subject line</span>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.subject}
                onChange={(event) => setForm({ ...form, subject: event.target.value })}
                placeholder="Limited time: Buy 2, Get 1 Free"
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Preview text</span>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.previewText}
                onChange={(event) => setForm({ ...form, previewText: event.target.value })}
                placeholder="Shown after the subject in most inboxes"
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Headline</span>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.headline}
                onChange={(event) => setForm({ ...form, headline: event.target.value })}
                placeholder="Limited-Time Buy 2, Get 1"
              />
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Message</span>
              <textarea
                rows={7}
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.body}
                onChange={(event) => setForm({ ...form, body: event.target.value })}
                placeholder={"Plain text. Leave a blank line between paragraphs.\n\nNo HTML — the branded layout is applied automatically."}
              />
            </label>
          </div>

          <div className="space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Promo code (optional)</span>
              <input
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.promoCode}
                onChange={(event) => setForm({ ...form, promoCode: event.target.value })}
                placeholder="B2G1"
              />
              <span className="mt-1 block text-[11px] text-zinc-600">
                Displayed in the email. Create the actual coupon under Coupons — this field doesn&apos;t create one.
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Button text</span>
                <input
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                  value={form.ctaLabel}
                  onChange={(event) => setForm({ ...form, ctaLabel: event.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Button link</span>
                <input
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                  value={form.ctaPath}
                  onChange={(event) => setForm({ ...form, ctaPath: event.target.value })}
                  placeholder="/products"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Send to</span>
              <select
                className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                value={form.segment}
                onChange={(event) => setForm({ ...form, segment: event.target.value, segmentParam: "" })}
              >
                {segments.map((segment) => (
                  <option key={segment.value} value={segment.value} className="bg-zinc-900">
                    {segment.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-zinc-600">{activeSegment?.hint}</span>
            </label>

            {activeSegment?.needsParam ? (
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Category</span>
                <select
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                  value={form.segmentParam}
                  onChange={(event) => setForm({ ...form, segmentParam: event.target.value })}
                >
                  <option value="" className="bg-zinc-900">Choose a category…</option>
                  {categories.map((category) => (
                    <option key={category} value={category} className="bg-zinc-900">{category}</option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Audience size</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {audienceCount === null ? "…" : audienceCount}
              </p>
              <p className="mt-1 text-[11px] text-zinc-600">
                Opted-in subscribers matching this segment, minus anyone who unsubscribed.
              </p>
            </div>

            {/*
              Shown only when there is something to say. A panel that is always
              present, usually green, is a panel that stops being read — and the
              one time it turns red it gets clicked past with everything else.
            */}
            {deliverability.findings.length > 0 ? (
              <div
                className={`rounded-xl border p-4 ${
                  deliverability.risk === "high"
                    ? "border-red-500/40 bg-red-500/[0.07]"
                    : "border-amber-400/35 bg-amber-400/[0.06]"
                }`}
              >
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  {deliverability.risk === "high" ? "Likely to be filtered as spam" : "Could be stronger"}
                </p>
                <ul className="mt-3 space-y-3">
                  {deliverability.findings.map((finding) => (
                    <li key={finding.code} className="text-[13px] leading-relaxed">
                      <span className={finding.severity === "critical" ? "text-red-200" : "text-amber-100"}>
                        {finding.message}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-zinc-400">{finding.fix}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 border-t border-white/10 pt-2 text-[11px] text-zinc-500">
                  A guide, not a verdict — no local check can predict a mailbox provider&apos;s decision.
                  Clearing these removes the signals that are known to count against you.
                </p>
              </div>
            ) : null}

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Send a test to</span>
              <div className="mt-1 flex gap-2">
                <input
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                  value={testEmail}
                  onChange={(event) => setTestEmail(event.target.value)}
                  placeholder="you@example.com"
                />
                <button
                  type="button"
                  disabled={busy || !testEmail || Boolean(blockedReason)}
                  onClick={handleTest}
                  className="shrink-0 rounded-lg border border-white/15 px-3 py-2 text-sm text-white disabled:opacity-40"
                >
                  Test
                </button>
              </div>
            </label>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Schedule for</span>
              <div className="mt-1 flex gap-2">
                <input
                  type="datetime-local"
                  className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy || !scheduleAt || Boolean(blockedReason)}
                  onClick={() => handleSend("schedule")}
                  className="shrink-0 rounded-lg border border-white/15 px-3 py-2 text-sm text-white disabled:opacity-40"
                >
                  Schedule
                </button>
              </div>
            </label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={handleSave}
            className="rounded-full border border-white/15 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={busy || Boolean(blockedReason)}
            onClick={() => handleSend("now")}
            className="rounded-full bg-emerald-400 px-5 py-2 text-sm font-semibold text-black disabled:opacity-40"
          >
            Send now
          </button>
          {editingId ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setForm(EMPTY_FORM); setEditingId(null); setMessage(null); }}
              className="rounded-full border border-white/10 px-5 py-2 text-sm text-zinc-400"
            >
              New campaign
            </button>
          ) : null}
        </div>
      </section>

      {/* History ------------------------------------------------------- */}
      <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Campaign history</h2>
        {dashboard.campaigns.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No campaigns yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                  <th className="py-2 pr-3">Campaign</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Sent</th>
                  <th className="py-2 pr-3">Opened</th>
                  <th className="py-2 pr-3">Clicked</th>
                  <th className="py-2 pr-3">Orders</th>
                  <th className="py-2 pr-3">Revenue</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {dashboard.campaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-t border-white/5">
                    <td className="py-2.5 pr-3">
                      <p className="font-medium text-white">{campaign.name}</p>
                      <p className="text-[11px] text-zinc-500">{campaign.subject}</p>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="text-xs text-zinc-400">{campaign.status}</span>
                      {campaign.pending > 0 ? (
                        <span className="block text-[11px] text-amber-300/80">{campaign.pending} queued</span>
                      ) : null}
                      {campaign.cancelled > 0 ? (
                        <span className="block text-[11px] text-zinc-500">{campaign.cancelled} stopped</span>
                      ) : null}
                    </td>
                    <td className="py-2.5 pr-3">{campaign.sent}</td>
                    <td className="py-2.5 pr-3">{percent(campaign.opened, campaign.sent)}</td>
                    <td className="py-2.5 pr-3">{percent(campaign.clicked, campaign.sent)}</td>
                    <td className="py-2.5 pr-3">{campaign.orders}</td>
                    <td className="py-2.5 pr-3 text-emerald-300">{money(campaign.revenue)}</td>
                    <td className="py-2.5">
                      <div className="flex flex-col items-start gap-1">
                        <button
                          type="button"
                          onClick={() => loadIntoComposer(campaign)}
                          className="text-xs text-cyan-300 hover:underline"
                        >
                          Duplicate
                        </button>
                        {/* Only offered while something is actually in flight —
                            a finished campaign has nothing left to stop, and an
                            enabled-looking button that always errors is worse
                            than no button. */}
                        {campaign.status === "sending" || campaign.status === "scheduled" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleStop(campaign)}
                            className="text-xs font-semibold text-rose-300 hover:underline disabled:opacity-40"
                          >
                            Stop sending
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Automations ---------------------------------------------------- */}
      <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Automated sequences</h2>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          These send themselves when a customer crosses the threshold — no campaign needed. Each person receives
          any given sequence once; a win-back can fire again only after they buy and lapse a second time.
        </p>

        {automationDrafts.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">Run the email-campaigns migration to enable automations.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {automationDrafts.map((row, index) => (
              <div key={row.key} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium capitalize text-white">{row.key.replace(/_/g, " ")}</p>
                    <p className="text-[11px] text-zinc-500">
                      {row.key === "welcome_no_purchase" && "Signed up but hasn't ordered yet."}
                      {row.key === "post_purchase" && "Sent after each order."}
                      {row.key.startsWith("winback") && "Sent once a customer goes quiet."}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(event) => {
                        const next = [...automationDrafts];
                        next[index] = { ...row, enabled: event.target.checked };
                        setAutomationDrafts(next);
                      }}
                    />
                    Enabled
                  </label>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Send after (days)</span>
                    <input
                      type="number"
                      min={1}
                      className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                      value={row.delay_days}
                      onChange={(event) => {
                        const next = [...automationDrafts];
                        next[index] = { ...row, delay_days: Number(event.target.value) };
                        setAutomationDrafts(next);
                      }}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Subject</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                      value={row.subject}
                      onChange={(event) => {
                        const next = [...automationDrafts];
                        next[index] = { ...row, subject: event.target.value };
                        setAutomationDrafts(next);
                      }}
                    />
                  </label>
                </div>

                <label className="mt-3 block">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Headline</span>
                  <input
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                    value={row.headline}
                    onChange={(event) => {
                      const next = [...automationDrafts];
                      next[index] = { ...row, headline: event.target.value };
                      setAutomationDrafts(next);
                    }}
                  />
                </label>

                <label className="mt-3 block">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">Message</span>
                  <textarea
                    rows={4}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                    value={row.body}
                    onChange={(event) => {
                      const next = [...automationDrafts];
                      next[index] = { ...row, body: event.target.value };
                      setAutomationDrafts(next);
                    }}
                  />
                </label>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveAutomation(automationDrafts[index])}
                  className="mt-3 rounded-full border border-white/15 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
