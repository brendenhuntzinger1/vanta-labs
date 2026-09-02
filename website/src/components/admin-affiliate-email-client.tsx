"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AFFILIATE_MERGE_FIELDS } from "@/lib/email/affiliate-merge";
import { AFFILIATE_FILTERS, type AffiliateDirectoryEntry, type AffiliateFilter } from "@/lib/email/affiliate-audience-shared";
import { MAX_LINK_BUTTONS, type LinkButton } from "@/lib/email/affiliate-campaign-template";
import type { AffiliateCampaignSummary, AffiliateEmailDashboard } from "@/lib/admin-affiliate-email";

/**
 * Admin → Affiliates → Emails.
 *
 * A composer, an audience, a preview, and a history. The whole screen is built
 * around one rule: SENDING MUST BE HARD TO DO BY ACCIDENT, and everything else
 * must be easy. So a campaign is always saved as a draft first, Send Now opens a
 * confirmation naming the exact number of people it reaches, and the button that
 * actually sends is disabled until the owner types the word SEND.
 */

const INPUT = "mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-zinc-600";
const LABEL = "block text-[11px] uppercase tracking-[0.16em] text-zinc-500";
const HELP = "mt-1 text-[11px] text-zinc-600";
const BTN = "vl-focus-ring rounded-full border border-white/15 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40";
const BTN_PRIMARY = "vl-focus-ring rounded-full bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40";

type Draft = {
  id: string | null;
  name: string;
  subject: string;
  previewText: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaPath: string;
  linkButtons: LinkButton[];
  affiliateFilter: AffiliateFilter;
  affiliateIds: string[];
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  subject: "",
  previewText: "",
  headline: "",
  body: "",
  ctaLabel: "VIEW DETAILS",
  ctaPath: "/products",
  linkButtons: [],
  affiliateFilter: "all_active",
  affiliateIds: [],
};

function statusTone(status: string): string {
  if (status === "sent") return "text-emerald-300";
  if (status === "sending") return "text-sky-300";
  if (status === "scheduled") return "text-amber-300";
  if (status === "failed") return "text-rose-300";
  return "text-zinc-400";
}

export function AdminAffiliateEmailClient({ dashboard, canManage }: { dashboard: AffiliateEmailDashboard; canManage: boolean }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [directory, setDirectory] = useState<AffiliateDirectoryEntry[]>([]);
  // The resolved audience, tagged with the inputs it was resolved FOR. Keeping
  // the key alongside the number is what makes staleness derivable instead of
  // something the effect has to blank out synchronously: if the tag no longer
  // matches the current inputs, the count on screen belongs to a previous
  // audience and reads as "Counting…" rather than as a stale promise about how
  // many people are about to be mailed.
  const [audience, setAudience] = useState<{ key: string; count: number | null; error: string | null }>({
    key: "", count: null, error: null,
  });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ html: string; subject: string } | null>(null);
  const [previewDevice, setPreviewDevice] = useState<"desktop" | "mobile">("desktop");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [campaigns, setCampaigns] = useState<AffiliateCampaignSummary[]>(dashboard.campaigns);
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null);
  const [openCampaign, setOpenCampaign] = useState<Record<string, unknown> | null>(null);

  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    // Any edit invalidates the preview and the "saved" state, so the owner is
    // never looking at a preview of something other than what is in the boxes.
    setPreview(null);
  };

  useEffect(() => {
    if (!canManage) return;
    fetch("/api/admin/affiliates/recipients")
      .then((response) => response.json())
      .then((data) => { if (data?.success) setDirectory(data.affiliates ?? []); })
      .catch(() => undefined);
  }, [canManage]);

  // "This email will be sent to X affiliates" — recomputed whenever the audience
  // changes, server-side, using the SAME resolver the send itself uses. A count
  // computed in the browser from a cached list would drift from what actually
  // gets queued.
  // "Choose affiliates" with nobody ticked is zero by definition — DERIVED
  // rather than fetched or stored. Writing it into state from inside the effect
  // is both a cascading render and a second source of truth for a number the
  // inputs already determine.
  const selectionEmpty = draft.affiliateFilter === "selected" && draft.affiliateIds.length === 0;

  const audienceKey = `${draft.affiliateFilter}|${draft.affiliateIds.join(",")}`;

  useEffect(() => {
    if (!canManage || selectionEmpty) return;
    const params = new URLSearchParams({ filter: draft.affiliateFilter, ids: draft.affiliateIds.join(",") });
    let cancelled = false;
    fetch(`/api/admin/affiliates/campaigns?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setAudience(data?.success
          ? { key: audienceKey, count: data.count, error: null }
          : { key: audienceKey, count: null, error: data?.error ?? "Could not size this audience." });
      })
      .catch(() => {
        if (!cancelled) setAudience({ key: audienceKey, count: null, error: "Could not size this audience." });
      });
    return () => { cancelled = true; };
  }, [audienceKey, draft.affiliateFilter, draft.affiliateIds, canManage, selectionEmpty]);

  const payload = useMemo(() => ({
    name: draft.name,
    subject: draft.subject,
    previewText: draft.previewText,
    headline: draft.headline,
    body: draft.body,
    ctaLabel: draft.ctaLabel,
    ctaPath: draft.ctaPath,
    linkButtons: draft.linkButtons,
    affiliateFilter: draft.affiliateFilter,
    affiliateIds: draft.affiliateIds,
  }), [draft]);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/affiliates/campaigns/history");
      const data = await response.json();
      if (data?.success) setCampaigns(data.campaigns ?? []);
    } catch {
      // History is a report; failing to refresh it must never block a send.
    }
  }, []);

  /** Insert a personalisation variable at the cursor, not at the end. */
  const insertVariable = (token: string) => {
    const textarea = bodyRef.current;
    const chip = `{{${token}}}`;
    if (!textarea) { update("body", `${draft.body}${chip}`); return; }
    const start = textarea.selectionStart ?? draft.body.length;
    const end = textarea.selectionEnd ?? start;
    const next = `${draft.body.slice(0, start)}${chip}${draft.body.slice(end)}`;
    update("body", next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + chip.length, start + chip.length);
    });
  };

  async function saveDraft(): Promise<string | null> {
    setBusy("save");
    setMessage(null);
    try {
      const url = draft.id ? `/api/admin/affiliates/campaigns/${draft.id}` : "/api/admin/affiliates/campaigns";
      const response = await fetch(url, {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data?.success) { setMessage({ tone: "error", text: data?.error ?? "Could not save this draft." }); return null; }
      const id = draft.id ?? String(data.campaignId);
      setDraft((current) => ({ ...current, id }));
      setMessage({ tone: "ok", text: "Draft saved." });
      await refreshHistory();
      return id;
    } catch {
      setMessage({ tone: "error", text: "Could not save this draft." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function showPreview() {
    setBusy("preview");
    setMessage(null);
    try {
      const response = await fetch("/api/admin/affiliates/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!data?.success) { setMessage({ tone: "error", text: data?.error ?? "Could not build a preview." }); return; }
      setPreview({ html: data.html, subject: data.subject });
    } catch {
      setMessage({ tone: "error", text: "Could not build a preview." });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!testEmail.trim()) { setMessage({ tone: "error", text: "Enter the address to send the test to." }); return; }
    setBusy("test");
    const id = draft.id ?? await saveDraft();
    if (!id) { setBusy(null); return; }
    try {
      const response = await fetch(`/api/admin/email/campaigns/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "test", testEmail: testEmail.trim() }),
      });
      const data = await response.json();
      setMessage(data?.success
        ? { tone: "ok", text: `Test sent to ${testEmail.trim()}.` }
        : { tone: "error", text: data?.error ?? "Could not send the test." });
    } catch {
      setMessage({ tone: "error", text: "Could not send the test." });
    } finally {
      setBusy(null);
    }
  }

  async function schedule() {
    if (!scheduleAt) { setMessage({ tone: "error", text: "Pick a date and time first." }); return; }
    setBusy("schedule");
    const id = draft.id ?? await saveDraft();
    if (!id) { setBusy(null); return; }
    try {
      const response = await fetch(`/api/admin/email/campaigns/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "schedule", scheduledAt: new Date(scheduleAt).toISOString() }),
      });
      const data = await response.json();
      setMessage(data?.success
        ? { tone: "ok", text: `Scheduled. The sender runs every 30 minutes, so it goes out within half an hour of that time.` }
        : { tone: "error", text: data?.error ?? "Could not schedule this campaign." });
      if (data?.success) { await refreshHistory(); setDraft(EMPTY_DRAFT); }
    } catch {
      setMessage({ tone: "error", text: "Could not schedule this campaign." });
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    setBusy("send");
    const id = draft.id ?? await saveDraft();
    if (!id) { setBusy(null); setConfirmOpen(false); return; }
    try {
      const response = await fetch(`/api/admin/email/campaigns/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "now" }),
      });
      const data = await response.json();
      if (data?.success && data.status === "failed") {
        // The send ran and reached NOBODY — every address was refused. Reported
        // in the error tone rather than as a success with a zero next to it,
        // because the owner has to know the message did not land before they
        // move on believing it did.
        setMessage({
          tone: "error",
          text: "Nobody received this. Every address was refused by the email provider — check Settings → Email (provider, API key or SMTP password), then duplicate this campaign and send the copy.",
        });
        await refreshHistory();
      } else if (data?.success) {
        setMessage({ tone: "ok", text: `Sending to ${data.recipients ?? 0} affiliates. ${data.sent ?? 0} delivered so far; the rest go out on the next sweep.` });
        setDraft(EMPTY_DRAFT);
        setPreview(null);
      } else {
        setMessage({ tone: "error", text: data?.error ?? "Could not send this campaign." });
      }
      await refreshHistory();
    } catch {
      setMessage({ tone: "error", text: "Could not send this campaign." });
    } finally {
      setBusy(null);
      setConfirmOpen(false);
      setConfirmText("");
    }
  }

  async function duplicate(campaignId: string) {
    try {
      const response = await fetch(`/api/admin/affiliates/campaigns/${campaignId}`, { method: "POST" });
      const data = await response.json();
      if (!data?.success) { setMessage({ tone: "error", text: data?.error ?? "Could not duplicate." }); return; }
      await openDetail(String(data.campaignId), true);
      setMessage({ tone: "ok", text: "Duplicated into a new draft. Edit it and send when ready." });
      await refreshHistory();
    } catch {
      setMessage({ tone: "error", text: "Could not duplicate." });
    }
  }

  async function openDetail(campaignId: string, intoComposer = false) {
    try {
      const response = await fetch(`/api/admin/affiliates/campaigns/${campaignId}`);
      const data = await response.json();
      if (!data?.success) return;
      const campaign = data.campaign as Record<string, unknown>;
      if (intoComposer) {
        setDraft({
          id: String(campaign.id),
          name: String(campaign.name ?? ""),
          subject: String(campaign.subject ?? ""),
          previewText: String(campaign.previewText ?? ""),
          headline: String(campaign.headline ?? ""),
          body: String(campaign.body ?? ""),
          ctaLabel: String(campaign.ctaLabel ?? "VIEW DETAILS"),
          ctaPath: String(campaign.ctaPath ?? "/products"),
          linkButtons: (campaign.linkButtons as LinkButton[]) ?? [],
          affiliateFilter: (campaign.affiliateFilter as AffiliateFilter) ?? "all_active",
          affiliateIds: (campaign.affiliateIds as string[]) ?? [],
        });
        setOpenCampaignId(null);
        setOpenCampaign(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setOpenCampaignId(campaignId);
      setOpenCampaign(campaign);
    } catch {
      setMessage({ tone: "error", text: "Could not open that campaign." });
    }
  }

  if (!canManage) {
    return (
      <div className="rounded-2xl border border-white/10 bg-black/20 p-6 text-sm text-zinc-400">
        Your role does not have permission to email affiliates. Ask a manager or super admin.
      </div>
    );
  }

  const selectable = directory.filter((entry) => !entry.suppressed);
  // A count resolved for different inputs is not an answer about these ones.
  const audienceResolved = audience.key === audienceKey;
  const effectiveCount = selectionEmpty ? 0 : (audienceResolved ? audience.count : null);
  const effectiveError = selectionEmpty || !audienceResolved ? null : audience.error;
  const audienceLabel = effectiveCount === null
    ? "Counting…"
    : `This email will be sent to ${effectiveCount} affiliate${effectiveCount === 1 ? "" : "s"}.`;

  return (
    <div className="space-y-6">
      {message ? (
        <div
          data-testid="affiliate-email-message"
          className={`rounded-xl border px-4 py-3 text-sm ${
            message.tone === "ok" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Write to your affiliates</h2>
            <p className="mt-1 text-[11px] text-zinc-500">
              {dashboard.activeAffiliates} active affiliate{dashboard.activeAffiliates === 1 ? "" : "s"} can be reached.
            </p>
          </div>
          {draft.id ? <span className="text-[11px] text-zinc-500">Draft saved</span> : null}
        </header>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <label className={LABEL}>
            Campaign name
            <input className={INPUT} value={draft.name} onChange={(e) => update("name", e.target.value)}
              placeholder="September product launch" data-testid="field-name" />
            <span className={HELP}>Only you see this. It names the campaign in your history.</span>
          </label>

          <label className={LABEL}>
            Subject
            <input className={INPUT} value={draft.subject} onChange={(e) => update("subject", e.target.value)}
              placeholder="New product just launched" data-testid="field-subject" />
          </label>

          <label className={LABEL}>
            Preview text
            <input className={INPUT} value={draft.previewText} onChange={(e) => update("previewText", e.target.value)}
              placeholder="The line shown after the subject in an inbox" data-testid="field-preview-text" />
          </label>

          <label className={LABEL}>
            Headline
            <input className={INPUT} value={draft.headline} onChange={(e) => update("headline", e.target.value)}
              placeholder="TB-500 is live" data-testid="field-headline" />
          </label>
        </div>

        <div className="mt-4">
          <span className={LABEL}>Message</span>
          <textarea
            ref={bodyRef}
            className={`${INPUT} min-h-[220px] font-mono text-[13px] leading-relaxed`}
            value={draft.body}
            onChange={(e) => update("body", e.target.value)}
            placeholder={"Hey {{first_name}},\n\nWrite whatever you want to tell your affiliates here."}
            data-testid="field-body"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {AFFILIATE_MERGE_FIELDS.map((field) => (
              <button
                key={field.token}
                type="button"
                title={field.hint}
                onClick={() => insertVariable(field.token)}
                data-testid={`chip-${field.token}`}
                className="vl-focus-ring rounded-full border border-amber-400/40 px-3 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-400/10"
              >
                {`{{${field.token}}}`}
              </button>
            ))}
          </div>
          <p className={HELP}>
            These are filled in from each affiliate&apos;s own account when the email is generated, so everyone gets their own code, link and rate.
          </p>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            Main button text
            <input className={INPUT} value={draft.ctaLabel} onChange={(e) => update("ctaLabel", e.target.value)} data-testid="field-cta-label" />
          </label>
          <label className={LABEL}>
            Main button link
            <input className={INPUT} value={draft.ctaPath} onChange={(e) => update("ctaPath", e.target.value)}
              placeholder="/products  ·  https://…  ·  {{referral_link}}" data-testid="field-cta-path" />
          </label>
        </div>

        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={LABEL}>Extra links and resources</span>
            <button
              type="button"
              className={BTN}
              disabled={draft.linkButtons.length >= MAX_LINK_BUTTONS}
              data-testid="add-link-button"
              onClick={() => update("linkButtons", [...draft.linkButtons, { label: "", url: "" }])}
            >
              Add link
            </button>
          </div>
          <p className={HELP}>
            Product pages, sale pages, image folders, video, ad material — anything you want affiliates to have. Site links are click-tracked; external links open directly.
          </p>
          <div className="mt-3 space-y-2">
            {draft.linkButtons.map((button, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <input
                  className={INPUT} value={button.label} placeholder="Button text"
                  data-testid={`link-label-${index}`}
                  onChange={(e) => update("linkButtons", draft.linkButtons.map((b, i) => i === index ? { ...b, label: e.target.value } : b))}
                />
                <input
                  className={INPUT} value={button.url} placeholder="/products  ·  https://drive.google.com/…  ·  {{referral_link}}"
                  data-testid={`link-url-${index}`}
                  onChange={(e) => update("linkButtons", draft.linkButtons.map((b, i) => i === index ? { ...b, url: e.target.value } : b))}
                />
                <button
                  type="button" className={`${BTN} mt-1`} data-testid={`remove-link-${index}`}
                  onClick={() => update("linkButtons", draft.linkButtons.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Audience ---- */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Who gets this</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {AFFILIATE_FILTERS.map((filter) => (
            <label
              key={filter.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${
                draft.affiliateFilter === filter.value ? "border-amber-400/50 bg-amber-400/5" : "border-white/10"
              }`}
            >
              <input
                type="radio" name="affiliate-filter" className="mt-1"
                checked={draft.affiliateFilter === filter.value}
                data-testid={`audience-${filter.value}`}
                onChange={() => update("affiliateFilter", filter.value)}
              />
              <span>
                <span className="block font-medium text-white">{filter.label}</span>
                <span className="block text-[11px] text-zinc-500">{filter.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {draft.affiliateFilter === "selected" ? (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={LABEL}>Choose affiliates</span>
              <div className="flex gap-2">
                <button type="button" className={BTN} data-testid="select-all-affiliates"
                  onClick={() => update("affiliateIds", selectable.map((a) => a.id))}>Select all</button>
                <button type="button" className={BTN} data-testid="clear-affiliates"
                  onClick={() => update("affiliateIds", [])}>Clear</button>
              </div>
            </div>
            <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-white/10">
              {directory.length === 0 ? (
                <p className="p-3 text-sm text-zinc-500">No affiliates found.</p>
              ) : directory.map((entry) => (
                <label key={entry.id} className="flex items-center gap-3 border-b border-white/5 px-3 py-2 text-sm last:border-b-0">
                  <input
                    type="checkbox"
                    disabled={entry.suppressed}
                    checked={draft.affiliateIds.includes(entry.id)}
                    data-testid={`affiliate-${entry.id}`}
                    onChange={(e) => update("affiliateIds", e.target.checked
                      ? [...draft.affiliateIds, entry.id]
                      : draft.affiliateIds.filter((id) => id !== entry.id))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-white">{entry.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500">{entry.email} · {entry.referralCode} · {entry.commissionPercent}%</span>
                  </span>
                  {/* Shown rather than hidden: an owner looking for someone
                      specific needs to know WHY they cannot be mailed. */}
                  {entry.suppressed ? <span className="text-[11px] text-amber-300/80">unsubscribed</span> : null}
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-4 text-sm font-medium text-white" data-testid="audience-count">
          {effectiveError ? <span className="text-rose-300">{effectiveError}</span> : audienceLabel}
        </p>
      </section>

      {/* ---- Actions ---- */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Check it, then send it</h2>

        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" className={BTN} onClick={saveDraft} disabled={busy !== null} data-testid="save-draft">
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className={BTN} onClick={showPreview} disabled={busy !== null} data-testid="preview-email">
            {busy === "preview" ? "Building…" : "Preview email"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_auto]">
          <label className={LABEL}>
            Send a test to yourself
            <input className={INPUT} type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)}
              placeholder="you@vantalabs.com" data-testid="field-test-email" />
          </label>
          <button type="button" className={`${BTN} mt-6 h-fit`} onClick={sendTest} disabled={busy !== null} data-testid="send-test">
            {busy === "test" ? "Sending…" : "Send test"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_auto]">
          <label className={LABEL}>
            Schedule for later
            <input className={INPUT} type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)}
              data-testid="field-schedule-at" />
            <span className={HELP}>The sender runs every 30 minutes, so a scheduled send goes out within half an hour of the time you pick.</span>
          </label>
          <button type="button" className={`${BTN} mt-6 h-fit`} onClick={schedule} disabled={busy !== null} data-testid="schedule-send">
            {busy === "schedule" ? "Scheduling…" : "Schedule"}
          </button>
        </div>

        <div className="mt-6 border-t border-white/10 pt-4">
          <button
            type="button"
            className={BTN_PRIMARY}
            data-testid="open-send-confirm"
            disabled={busy !== null || !draft.name || !draft.subject || !draft.headline || !draft.body}
            onClick={() => { setConfirmOpen(true); setConfirmText(""); }}
          >
            Send now…
          </button>
          <p className={HELP}>Opens a confirmation. Nothing is sent until you confirm.</p>
        </div>
      </section>

      {/* ---- Confirmation ---- */}
      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" data-testid="send-confirm-modal">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-zinc-950 p-5">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-200">Send this to affiliates?</h3>
            <p className="mt-3 text-sm text-zinc-300">
              <strong className="text-white">{effectiveCount ?? 0}</strong> affiliate{effectiveCount === 1 ? "" : "s"} will receive
              {" "}<strong className="text-white">{draft.subject || "this email"}</strong>. This cannot be undone.
            </p>
            <label className="mt-4 block text-[11px] uppercase tracking-[0.16em] text-zinc-500">
              Type SEND to confirm
              <input className={INPUT} value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                data-testid="confirm-input" autoComplete="off" />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={BTN} onClick={() => { setConfirmOpen(false); setConfirmText(""); }} data-testid="confirm-cancel">
                Cancel
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                data-testid="confirm-send"
                // Disabled while a send is in flight as well as before the word
                // is typed, so an impatient second click cannot fire a second
                // request. The server refuses a duplicate regardless; this is
                // the first of the two guards, not the only one.
                disabled={confirmText.trim().toUpperCase() !== "SEND" || busy !== null || !effectiveCount}
                onClick={sendNow}
              >
                {busy === "send" ? "Sending…" : `Send to ${effectiveCount ?? 0}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---- Preview ---- */}
      {preview ? (
        <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6" data-testid="preview-panel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Preview</h2>
              <p className="mt-1 text-[11px] text-zinc-500">Subject: {preview.subject}</p>
            </div>
            <div className="flex gap-2">
              {(["desktop", "mobile"] as const).map((device) => (
                <button
                  key={device} type="button" data-testid={`preview-${device}`}
                  onClick={() => setPreviewDevice(device)}
                  className={`vl-focus-ring rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] ${
                    previewDevice === device ? "bg-zinc-100 text-zinc-950" : "border border-zinc-800 text-zinc-400"
                  }`}
                >
                  {device}
                </button>
              ))}
              <button type="button" className={BTN} onClick={() => setPreview(null)} data-testid="close-preview">Close</button>
            </div>
          </div>
          <div className="mt-4 flex justify-center">
            <iframe
              title="Email preview"
              data-testid="preview-frame"
              srcDoc={preview.html}
              // Sandboxed with NO allow-scripts: the preview renders operator
              // content and must never execute anything.
              sandbox=""
              className="h-[600px] rounded-xl border border-white/10 bg-black"
              style={{ width: previewDevice === "mobile" ? 390 : "100%", maxWidth: "100%" }}
            />
          </div>
        </section>
      ) : null}

      {/* ---- History ---- */}
      <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Campaign history</h2>
        {campaigns.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No affiliate campaigns yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                <tr>
                  <th className="py-2 pr-3">Campaign</th>
                  <th className="py-2 pr-3">Audience</th>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Recipients</th>
                  <th className="py-2 pr-3">Delivered</th>
                  <th className="py-2 pr-3">Failed</th>
                  <th className="py-2 pr-3">Opens</th>
                  <th className="py-2 pr-3">Clicks</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {campaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-t border-white/5" data-testid={`campaign-row-${campaign.id}`}>
                    <td className="py-2.5 pr-3">
                      <span className="block font-medium text-white">{campaign.name}</span>
                      <span className="block text-[11px] text-zinc-500">{campaign.subject}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-[11px] text-zinc-400">{campaign.audience}</td>
                    <td className="py-2.5 pr-3 text-[11px] text-zinc-400">
                      {campaign.completedAt || campaign.scheduledAt || campaign.createdAt
                        ? new Date(campaign.completedAt ?? campaign.scheduledAt ?? campaign.createdAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="py-2.5 pr-3">{campaign.recipientCount}</td>
                    <td className="py-2.5 pr-3 text-emerald-300">{campaign.sent}</td>
                    <td className="py-2.5 pr-3 text-rose-300">{campaign.failed + campaign.suppressed}</td>
                    <td className="py-2.5 pr-3">{campaign.opened}</td>
                    <td className="py-2.5 pr-3">{campaign.clicked}</td>
                    <td className={`py-2.5 pr-3 capitalize ${statusTone(campaign.status)}`}>{campaign.status}</td>
                    <td className="py-2.5">
                      <div className="flex gap-2">
                        <button type="button" className={BTN} data-testid={`open-${campaign.id}`} onClick={() => openDetail(campaign.id)}>Open</button>
                        <button type="button" className={BTN} data-testid={`duplicate-${campaign.id}`} onClick={() => duplicate(campaign.id)}>Duplicate</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---- One campaign, exactly as it was sent ---- */}
      {openCampaignId && openCampaign ? (
        <section className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-6" data-testid="campaign-detail">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">{String(openCampaign.name)}</h2>
            <button type="button" className={BTN} onClick={() => { setOpenCampaignId(null); setOpenCampaign(null); }} data-testid="close-detail">Close</button>
          </div>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Subject</dt><dd className="text-white">{String(openCampaign.subject)}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">Headline</dt><dd className="text-white">{String(openCampaign.headline)}</dd></div>
          </dl>
          <div className="mt-4">
            <span className={LABEL}>Message that was sent</span>
            <pre className="mt-1 whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-3 text-[13px] text-zinc-300">{String(openCampaign.body)}</pre>
          </div>
          {Array.isArray(openCampaign.linkClicks) ? (
            <div className="mt-4">
              <span className={LABEL}>Clicks by link</span>
              <ul className="mt-1 space-y-1 text-sm text-zinc-300">
                {(openCampaign.linkClicks as Array<{ label: string; clicks: number }>).map((link, index) => (
                  <li key={index} className="flex justify-between border-b border-white/5 py-1">
                    <span>{link.label}</span><span className="text-white">{link.clicks}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
