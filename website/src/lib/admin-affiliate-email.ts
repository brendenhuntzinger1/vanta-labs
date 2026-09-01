import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { isSafeSitePath } from "@/lib/email/cta-path";
import { getSiteUrl } from "@/lib/env";
import { validateMergeFields } from "@/lib/email/affiliate-merge";
import { isAffiliateFilter, type AffiliateFilter } from "@/lib/email/affiliate-audience";
import { normalizeLinkButtons, type LinkButton } from "@/lib/email/affiliate-campaign-template";

/**
 * The affiliate broadcast admin: validation, history, and one campaign's detail.
 *
 * Reads the SAME tables the customer email dashboard reads, filtered to
 * `audience_kind = 'affiliate'`. There is no second campaign store, so a number
 * shown here and a number shown there can never disagree about the same send.
 */

export type AffiliateCampaignInput = {
  name: string;
  subject: string;
  previewText: string | null;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaPath: string;
  linkButtons: LinkButton[];
  affiliateFilter: AffiliateFilter;
  affiliateIds: string[];
};

/**
 * Is this a destination an affiliate button may point at?
 *
 * Wider than the customer composer's rule, and deliberately so: affiliates are
 * sent marketing resources that genuinely live elsewhere — an image folder, a
 * video, a shared drive. Three shapes are allowed, and each is safe for a
 * different reason:
 *
 *   * a site path — click-tracked through the redirect, which resolves it to
 *     this origin on the way out;
 *   * an absolute http(s) URL — rendered as a plain link, never routed through
 *     the redirect, so it cannot turn that redirect into an open one;
 *   * a merge variable — per-recipient, also rendered as a plain link.
 *
 * Everything else (javascript:, data:, mailto: dressed up as a button) is
 * refused. An allow-list, not a deny-list.
 */
export function isAllowedAffiliateLink(url: string): boolean {
  const value = String(url ?? "").trim();
  if (!value) return false;
  if (value.includes("{{")) return true;
  const lowered = value.toLowerCase();
  if (lowered.startsWith("http://") || lowered.startsWith("https://")) return true;
  return isSafeSitePath(value, getSiteUrl());
}

/**
 * Validate composer input.
 *
 * Pure, so the rules are testable and so the create and edit routes cannot
 * disagree about them. The merge check is the one that matters most day to day:
 * this is the last moment a mistyped `{{firstname}}` can be fixed for free,
 * because after a send it is in a message that cannot be recalled.
 */
export function validateAffiliateCampaignInput(
  input: Record<string, unknown>,
): { ok: true; value: AffiliateCampaignInput } | { ok: false; error: string } {
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

  const name = text(input.name, 120);
  const subject = text(input.subject, 200);
  const headline = text(input.headline, 200);
  const body = text(input.body, 20_000);

  if (!name) return { ok: false, error: "Campaign name is required." };
  if (!subject) return { ok: false, error: "Subject line is required." };
  if (!headline) return { ok: false, error: "Headline is required." };
  if (!body) return { ok: false, error: "Message body is required." };

  const previewText = text(input.previewText, 200) || null;
  const ctaLabel = text(input.ctaLabel, 40) || "VIEW DETAILS";
  const ctaPath = text(input.ctaPath, 500) || "/products";

  if (!isAllowedAffiliateLink(ctaPath)) {
    return { ok: false, error: "The button link must be a path on this site (like /products), a full https:// link, or a personalisation variable." };
  }

  const linkButtons = normalizeLinkButtons(input.linkButtons);
  for (const button of linkButtons) {
    if (!isAllowedAffiliateLink(button.url)) {
      return { ok: false, error: `"${button.label}" needs a valid link — a path on this site, a full https:// link, or a personalisation variable.` };
    }
  }

  // Every field an affiliate will actually read, checked in one pass.
  const merge = validateMergeFields(subject, previewText, headline, body, ctaLabel, ctaPath, ...linkButtons.flatMap((b) => [b.label, b.url]));
  if (!merge.ok) return { ok: false, error: merge.error };

  const affiliateFilter = text(input.affiliateFilter, 40) || "all_active";
  if (!isAffiliateFilter(affiliateFilter)) {
    return { ok: false, error: "Unknown affiliate audience." };
  }

  const affiliateIds = Array.isArray(input.affiliateIds)
    ? Array.from(new Set(input.affiliateIds.map((id) => String(id)).filter(Boolean))).slice(0, 5_000)
    : [];

  // "Choose affiliates" with nobody chosen is a half-finished thought, not an
  // instruction to mail the whole programme. Refused here rather than resolved
  // to an empty audience, so the owner is told instead of seeing a silent no-op.
  if (affiliateFilter === "selected" && affiliateIds.length === 0) {
    return { ok: false, error: "Pick at least one affiliate, or switch to a different audience." };
  }

  return {
    ok: true,
    value: { name, subject, previewText, headline, body, ctaLabel, ctaPath, linkButtons, affiliateFilter, affiliateIds },
  };
}

export type AffiliateCampaignSummary = {
  id: string;
  name: string;
  subject: string;
  status: string;
  audience: string;
  createdAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
  recipientCount: number;
  sent: number;
  failed: number;
  suppressed: number;
  pending: number;
  opened: number;
  clicked: number;
};

export type AffiliateEmailDashboard = {
  activeAffiliates: number;
  campaigns: AffiliateCampaignSummary[];
  totals: { sent: number; opened: number; clicked: number; failed: number };
};

const AUDIENCE_LABELS: Record<string, string> = {
  all_active: "All active affiliates",
  selected: "Selected affiliates",
  no_sales: "No qualifying sales yet",
  has_sales: "Has qualifying sales",
};

export function affiliateAudienceLabel(filter: string | null | undefined, selectedCount: number): string {
  const key = String(filter ?? "all_active");
  if (key === "selected") return `${selectedCount} selected affiliate${selectedCount === 1 ? "" : "s"}`;
  return AUDIENCE_LABELS[key] ?? key;
}

/** Campaign history for the affiliate tab. */
export async function getAffiliateEmailDashboard(): Promise<AffiliateEmailDashboard> {
  const { data: campaignRows } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, subject, status, created_at, scheduled_at, completed_at, recipient_count, affiliate_filter, affiliate_ids")
    .eq("audience_kind", "affiliate")
    .order("created_at", { ascending: false })
    .limit(100);

  const campaignIds = (campaignRows ?? []).map((row) => String(row.id));

  // Reporting, not sending — a short read here misstates a rate rather than
  // mailing anyone, so it is bounded but not fatal. Same posture as
  // getEmailDashboard.
  const recipientRows = campaignIds.length > 0
    ? (await readAllRowsBounded<{ campaign_id: string; status: string; opened_at: string | null; clicked_at: string | null }>(
        (from, to) => supabaseAdmin
          .from("email_campaign_recipients")
          .select("campaign_id, status, opened_at, clicked_at")
          .in("campaign_id", campaignIds)
          .order("campaign_id", { ascending: true })
          .range(from, to),
        { maxRows: 500_000, label: "affiliate campaign recipient read" },
      )).rows
    : [];

  type Tally = { sent: number; failed: number; suppressed: number; pending: number; opened: number; clicked: number };
  const blank = (): Tally => ({ sent: 0, failed: 0, suppressed: 0, pending: 0, opened: 0, clicked: 0 });
  const tallies = new Map<string, Tally>();

  for (const row of recipientRows) {
    const id = String(row.campaign_id ?? "");
    if (!id) continue;
    const tally = tallies.get(id) ?? blank();
    const status = String(row.status ?? "");
    if (status === "sent") tally.sent++;
    else if (status === "failed") tally.failed++;
    else if (status === "suppressed") tally.suppressed++;
    else tally.pending++;
    if (row.opened_at) tally.opened++;
    if (row.clicked_at) tally.clicked++;
    tallies.set(id, tally);
  }

  const campaigns: AffiliateCampaignSummary[] = (campaignRows ?? []).map((row) => {
    const id = String(row.id);
    const tally = tallies.get(id) ?? blank();
    const selected = Array.isArray(row.affiliate_ids) ? row.affiliate_ids.length : 0;
    return {
      id,
      name: String(row.name ?? ""),
      subject: String(row.subject ?? ""),
      status: String(row.status ?? "draft"),
      audience: affiliateAudienceLabel(row.affiliate_filter as string | null, selected),
      createdAt: String(row.created_at ?? ""),
      scheduledAt: (row.scheduled_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
      recipientCount: Number(row.recipient_count ?? 0),
      ...tally,
    };
  });

  let activeAffiliates = 0;
  try {
    const { listAffiliateDirectory } = await import("@/lib/email/affiliate-audience");
    const directory = await listAffiliateDirectory();
    activeAffiliates = directory.filter((entry) => !entry.suppressed).length;
  } catch {
    // A directory hiccup shouldn't blank the whole page.
    activeAffiliates = 0;
  }

  const totals = campaigns.reduce(
    (acc, campaign) => ({
      sent: acc.sent + campaign.sent,
      opened: acc.opened + campaign.opened,
      clicked: acc.clicked + campaign.clicked,
      failed: acc.failed + campaign.failed,
    }),
    { sent: 0, opened: 0, clicked: 0, failed: 0 },
  );

  return { activeAffiliates, campaigns, totals };
}

export type AffiliateCampaignDetail = AffiliateCampaignInput & {
  id: string;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  /** Per-button click counts. Index null is the primary CTA. */
  linkClicks: Array<{ linkIndex: number | null; label: string; clicks: number }>;
  recipients: Array<{ email: string; status: string; openedAt: string | null; clickedAt: string | null; error: string | null }>;
};

/** Open an old campaign and see exactly what was sent, and to whom. */
export async function getAffiliateCampaignDetail(campaignId: string): Promise<AffiliateCampaignDetail | null> {
  const { data: row } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, subject, preview_text, headline, body, cta_label, cta_path, link_buttons, affiliate_filter, affiliate_ids, status, created_at, scheduled_at, audience_kind")
    .eq("id", campaignId)
    .maybeSingle();
  if (!row || String(row.audience_kind ?? "") !== "affiliate") return null;

  const linkButtons = normalizeLinkButtons(row.link_buttons);

  const { data: clickRows } = await supabaseAdmin
    .from("email_campaign_clicks")
    .select("link_index, link_label")
    .eq("campaign_id", campaignId)
    .limit(50_000);

  const clicksByIndex = new Map<string, number>();
  for (const click of clickRows ?? []) {
    const key = click.link_index === null || click.link_index === undefined ? "cta" : String(click.link_index);
    clicksByIndex.set(key, (clicksByIndex.get(key) ?? 0) + 1);
  }

  const linkClicks = [
    { linkIndex: null as number | null, label: String(row.cta_label ?? "Primary button"), clicks: clicksByIndex.get("cta") ?? 0 },
    ...linkButtons.map((button, index) => ({
      linkIndex: index as number | null,
      label: button.label,
      clicks: clicksByIndex.get(String(index)) ?? 0,
    })),
  ];

  const { rows: recipientRows } = await readAllRowsBounded<{ email: string; status: string; opened_at: string | null; clicked_at: string | null; error: string | null }>(
    (from, to) => supabaseAdmin
      .from("email_campaign_recipients")
      .select("email, status, opened_at, clicked_at, error")
      .eq("campaign_id", campaignId)
      .order("email", { ascending: true })
      .range(from, to),
    { maxRows: 20_000, label: "affiliate campaign recipient detail" },
  );

  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    subject: String(row.subject ?? ""),
    previewText: (row.preview_text as string | null) ?? null,
    headline: String(row.headline ?? ""),
    body: String(row.body ?? ""),
    ctaLabel: String(row.cta_label ?? ""),
    ctaPath: String(row.cta_path ?? ""),
    linkButtons,
    affiliateFilter: (String(row.affiliate_filter ?? "all_active")) as AffiliateFilter,
    affiliateIds: Array.isArray(row.affiliate_ids) ? row.affiliate_ids.map(String) : [],
    status: String(row.status ?? "draft"),
    createdAt: String(row.created_at ?? ""),
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    linkClicks,
    recipients: recipientRows.map((r) => ({
      email: String(r.email),
      status: String(r.status),
      openedAt: r.opened_at ?? null,
      clickedAt: r.clicked_at ?? null,
      error: r.error ?? null,
    })),
  };
}
