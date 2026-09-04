import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { loadConsentedAudience } from "@/lib/email/audience";
import { isSafeSitePath } from "@/lib/email/cta-path";
import { getSiteUrl } from "@/lib/env";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { mergeSubscriberDirectory, type SubscriberDirectory } from "@/lib/email/subscriber-directory";

/**
 * Reporting for the admin Email tab.
 *
 * The interesting number here is REVENUE PER CAMPAIGN, and it is computed from
 * `orders.attributed_campaign_id` — stamped once at order creation, never
 * recomputed — rather than by re-joining click history at read time. Attribution
 * is a claim about what was true when the order was placed; deriving it live
 * would let a later campaign quietly take credit for an earlier one's sales.
 *
 * Revenue is NET of refunds, matching every other revenue figure in the admin.
 * Gross would flatter a campaign whose orders were later refunded, which is
 * exactly the campaign you would most want to notice.
 */

export type CampaignSummary = {
  id: string;
  name: string;
  subject: string;
  segment: string;
  segmentParam: string | null;
  status: string;
  createdAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
  recipientCount: number;
  sent: number;
  failed: number;
  suppressed: number;
  pending: number;
  cancelled: number;
  opened: number;
  clicked: number;
  /**
   * From the provider's delivery webhook, joined through the message id each
   * send recorded. Zero for sends made before provider_message_id was kept on
   * campaign rows (2026-09-04), and for SMTP, which returns no id — which is
   * why these sit beside `sent` rather than being expressed as a rate of it.
   */
  delivered: number;
  bounced: number;
  complained: number;
  /** People who used THIS campaign's unsubscribe link. */
  unsubscribed: number;
  orders: number;
  revenue: number;
};

export type EmailDashboard = {
  subscribers: number;
  campaigns: CampaignSummary[];
  totals: {
    sent: number;
    opened: number;
    clicked: number;
    orders: number;
    revenue: number;
  };
};

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export { rate as campaignRate };

export async function getEmailDashboard(): Promise<EmailDashboard> {
  const [{ data: campaignRows }, recipientRows, orderRows] = await Promise.all([
    supabaseAdmin
      .from("email_campaigns")
      .select("id, name, subject, segment, segment_param, status, created_at, scheduled_at, completed_at, recipient_count")
      // CUSTOMER CAMPAIGNS ONLY.
      //
      // Affiliate broadcasts live in this same table (see
      // affiliate-email-system.sql for why a shared table beats a second
      // mailer), so without this filter they appear in the customer campaign
      // history and — worse — their sends, opens and clicks are added into the
      // totals at the top of this page. Those totals are read as "how is
      // customer marketing performing", and an affiliate announcement is not
      // an answer to that question.
      //
      // `audience_kind` is NOT NULL with default 'customer', so every campaign
      // that existed before affiliate broadcasts did matches this and keeps its
      // place in the history exactly as before.
      .eq("audience_kind", "customer")
      .order("created_at", { ascending: false })
      .limit(100),
    // Reporting, not sending — a short read here misstates open rates rather
    // than mailing anyone, so it is bounded but not fatal (F-A-19).
    readAllRowsBounded<{ campaign_id: string; status: string; opened_at: string | null; clicked_at: string | null }>(
      (from, to) => supabaseAdmin
        .from("email_campaign_recipients")
        .select("campaign_id, status, opened_at, clicked_at")
        .order("campaign_id", { ascending: true })
        .range(from, to),
      { maxRows: 500_000, label: "campaign recipient read" },
    ).then((r) => r.rows),
    // PRIMARY CREDIT ONLY. An order is credited to a campaign here when the
    // one-source rule (marketing-source.ts) chose that campaign — not merely
    // because its link was clicked at some point. Before this, an order that
    // followed a campaign click AND an automation click, or that redeemed an
    // automation's gift, was full revenue on this page and on the automations
    // panel at once.
    readAllRowsBounded<{ marketing_source_ref: string | null; payment_status: string; order_type: string | null; amount_paid: number | null; refund_amount: number | null }>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("marketing_source_ref, payment_status, order_type, amount_paid, refund_amount")
        .eq("marketing_source_kind", "campaign")
        .order("marketing_source_ref", { ascending: true })
        .range(from, to),
      { maxRows: 500_000, label: "campaign attribution read" },
    ).then((r) => r.rows),
  ]);

  type Tally = { sent: number; failed: number; suppressed: number; pending: number; cancelled: number; opened: number; clicked: number };
  const tallies = new Map<string, Tally>();
  const blank = (): Tally => ({ sent: 0, failed: 0, suppressed: 0, pending: 0, cancelled: 0, opened: 0, clicked: 0 });

  for (const row of recipientRows) {
    const id = String(row.campaign_id ?? "");
    if (!id) continue;
    const tally = tallies.get(id) ?? blank();
    const status = String(row.status ?? "");
    if (status === "sent") tally.sent++;
    else if (status === "failed") tally.failed++;
    else if (status === "suppressed") tally.suppressed++;
    // Stopped by an operator. Counted separately from 'pending' because those
    // mean opposite things: pending is still going out, cancelled never will.
    else if (status === "cancelled") tally.cancelled++;
    // 'claiming' is in flight, not a distinct outcome — counted as pending so
    // the numbers add up to the audience while a send is running.
    else tally.pending++;
    if (row.opened_at) tally.opened++;
    if (row.clicked_at) tally.clicked++;
    tallies.set(id, tally);
  }

  const revenueByCampaign = new Map<string, { orders: number; revenue: number }>();
  for (const row of orderRows) {
    // The canonical revenue rule, not the narrower "captured" one (review
    // finding 4). A campaign that drove a $200 order later refunded by $50
    // earned $150, and reported $0 here while the revenue page said $150.
    // isSaleOrder additionally keeps free replacement reships out of the ORDER
    // COUNT — they contribute no revenue but silently pad the denominator of
    // any revenue-per-order figure read off this dashboard.
    if (!isRevenueOrderStatus(row.payment_status as string | null)) continue;
    if (!isSaleOrder((row as { order_type?: string | null }).order_type)) continue;
    const id = String(row.marketing_source_ref ?? "");
    if (!id) continue;
    const entry = revenueByCampaign.get(id) ?? { orders: 0, revenue: 0 };
    entry.orders++;
    entry.revenue += netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null });
    revenueByCampaign.set(id, entry);
  }

  const deliveryByCampaign = await loadCampaignDeliveryOutcomes((campaignRows ?? []).map((row) => String(row.id)));

  const campaigns: CampaignSummary[] = (campaignRows ?? []).map((row) => {
    const id = String(row.id);
    const tally = tallies.get(id) ?? blank();
    const money = revenueByCampaign.get(id) ?? { orders: 0, revenue: 0 };
    const delivery = deliveryByCampaign.get(id) ?? { delivered: 0, bounced: 0, complained: 0, unsubscribed: 0 };
    return {
      id,
      name: String(row.name ?? ""),
      subject: String(row.subject ?? ""),
      segment: String(row.segment ?? "all"),
      segmentParam: (row.segment_param as string | null) ?? null,
      status: String(row.status ?? "draft"),
      createdAt: String(row.created_at ?? ""),
      scheduledAt: (row.scheduled_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
      recipientCount: Number(row.recipient_count ?? 0),
      ...tally,
      ...delivery,
      orders: money.orders,
      revenue: Math.round(money.revenue * 100) / 100,
    };
  });

  let subscribers = 0;
  try {
    const audience = await loadConsentedAudience();
    subscribers = audience.all.size;
  } catch {
    // A consent-store hiccup shouldn't blank the whole page.
    subscribers = 0;
  }

  const totals = campaigns.reduce(
    (acc, campaign) => ({
      sent: acc.sent + campaign.sent,
      opened: acc.opened + campaign.opened,
      clicked: acc.clicked + campaign.clicked,
      orders: acc.orders + campaign.orders,
      revenue: Math.round((acc.revenue + campaign.revenue) * 100) / 100,
    }),
    { sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 },
  );

  return { subscribers, campaigns, totals };
}

type DeliveryOutcomes = { delivered: number; bounced: number; complained: number; unsubscribed: number };

/**
 * What the provider and the recipients said about each campaign, after the send.
 *
 * Sends are joined to email_delivery_events EXACTLY, through the provider
 * message id the send log keeps, so one person on two campaigns is counted
 * against the right one. Unsubscribes come from email_suppressions.source,
 * written by /api/unsubscribe from the `s=` parameter each marketing link
 * carries. Never throws: a reporting read must not blank the composer.
 */
async function loadCampaignDeliveryOutcomes(campaignIds: string[]): Promise<Map<string, DeliveryOutcomes>> {
  const outcomes = new Map<string, DeliveryOutcomes>();
  if (campaignIds.length === 0) return outcomes;
  const entry = (id: string) => {
    const existing = outcomes.get(id);
    if (existing) return existing;
    const fresh = { delivered: 0, bounced: 0, complained: 0, unsubscribed: 0 };
    outcomes.set(id, fresh);
    return fresh;
  };

  try {
    const { rows: sends } = await readAllRowsBounded<{ reference_id: string | null; provider_message_id: string | null }>(
      (from, to) => supabaseAdmin
        .from("email_send_log")
        .select("reference_id, provider_message_id")
        .eq("campaign_type", "campaign")
        .in("reference_id", campaignIds)
        .not("provider_message_id", "is", null)
        .order("id", { ascending: true })
        .range(from, to),
      { maxRows: 500_000, label: "campaign send-log read" },
    );
    const campaignByMessage = new Map<string, string>();
    for (const row of sends) {
      if (row.provider_message_id && row.reference_id) campaignByMessage.set(row.provider_message_id, row.reference_id);
    }

    const ids = [...campaignByMessage.keys()];
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data } = await supabaseAdmin
        .from("email_delivery_events")
        .select("provider_message_id, kind")
        .in("provider_message_id", ids.slice(i, i + CHUNK));
      for (const row of (data ?? []) as Array<{ provider_message_id: string | null; kind: string }>) {
        const campaignId = row.provider_message_id ? campaignByMessage.get(row.provider_message_id) : undefined;
        if (!campaignId) continue;
        const tally = entry(campaignId);
        if (row.kind === "delivered") tally.delivered++;
        else if (row.kind === "hard_bounce" || row.kind === "soft_bounce") tally.bounced++;
        else if (row.kind === "complaint") tally.complained++;
      }
    }
  } catch (error) {
    console.error("[admin-email] delivery outcome read failed", error);
  }

  try {
    const { data } = await supabaseAdmin
      .from("email_suppressions")
      .select("source")
      .in("source", campaignIds.map((id) => `campaign:${id}`));
    for (const row of (data ?? []) as Array<{ source: string | null }>) {
      const id = String(row.source ?? "").replace(/^campaign:/, "");
      if (id) entry(id).unsubscribed++;
    }
  } catch {
    // The `source` column is added by email-lifecycle-2026-09-04.sql; until
    // then unsubscribes simply read as zero.
  }

  return outcomes;
}

/**
 * Validate composer input.
 *
 * Exported and pure so the rules are testable, and so the API route and any
 * future caller cannot disagree about them. The CTA check is the one that
 * matters for security: the stored path is what the click redirect sends
 * customers to, so an absolute URL must never survive this function.
 */
export function validateCampaignInput(input: Record<string, unknown>): { ok: true; value: {
  name: string; subject: string; previewText: string | null; headline: string; body: string;
  promoCode: string | null; ctaLabel: string; ctaPath: string; segment: string; segmentParam: string | null;
} } | { ok: false; error: string } {
  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

  const name = text(input.name, 120);
  const subject = text(input.subject, 200);
  const headline = text(input.headline, 200);
  const body = text(input.body, 8000);

  if (!name) return { ok: false, error: "Campaign name is required." };
  if (!subject) return { ok: false, error: "Subject line is required." };
  if (!headline) return { ok: false, error: "Headline is required." };
  if (!body) return { ok: false, error: "Message body is required." };

  const ctaPathRaw = text(input.ctaPath, 300) || "/products";
  // Same-origin only, decided by RESOLVING the path rather than by matching its
  // prefix — see lib/email/cta-path.ts for why `/\evil.com` defeats the
  // obvious-looking string test.
  if (!isSafeSitePath(ctaPathRaw, getSiteUrl())) {
    return { ok: false, error: "The button link must be a path on this site, like /products." };
  }

  return {
    ok: true,
    value: {
      name,
      subject,
      previewText: text(input.previewText, 200) || null,
      headline,
      body,
      promoCode: text(input.promoCode, 60) || null,
      ctaLabel: text(input.ctaLabel, 40) || "SHOP NOW",
      ctaPath: ctaPathRaw,
      segment: text(input.segment, 40) || "all",
      segmentParam: text(input.segmentParam, 80) || null,
    },
  };
}

/**
 * Every address that has ever consented or been suppressed, for the
 * Subscribers panel on Admin → Email. Reads the same three stores the audience
 * resolver reads, merged by subscriber-directory.ts. Bounded and non-fatal:
 * a short read shows a shorter list with `truncated` set, and a failed read
 * shows an empty panel rather than breaking the composer.
 */
const MAX_DIRECTORY_ROWS = 20_000;

export async function loadSubscriberDirectory(): Promise<SubscriberDirectory> {
  try {
    const [prefs, subs, suppressions] = await Promise.all([
      readAllRowsBounded<{ user_id: string }>(
        (from, to) => supabaseAdmin
          .from("customer_preferences")
          .select("user_id")
          .eq("marketing_emails", true)
          .order("user_id", { ascending: true })
          .range(from, to),
        { maxRows: MAX_DIRECTORY_ROWS, label: "subscriber directory prefs" },
      ),
      readAllRowsBounded<{ email: string; source: string | null; opted_in_at: string | null; unsubscribed_at: string | null }>(
        (from, to) => supabaseAdmin
          .from("marketing_subscribers")
          .select("email, source, opted_in_at, unsubscribed_at")
          .order("email", { ascending: true })
          .range(from, to),
        { maxRows: MAX_DIRECTORY_ROWS, label: "subscriber directory guests" },
      ),
      readAllRowsBounded<{ email: string; reason: string | null; source: string | null; created_at: string | null }>(
        (from, to) => supabaseAdmin
          .from("email_suppressions")
          .select("email, reason, source, created_at")
          .order("email", { ascending: true })
          .range(from, to),
        { maxRows: MAX_DIRECTORY_ROWS, label: "subscriber directory suppressions" },
      ),
    ]);

    // Opted-in account ids → addresses, paging the auth list once, exactly
    // as loadConsentedAudience does.
    const optedIn = new Set(prefs.rows.map((row) => String(row.user_id)));
    const accounts: Array<{ email: string; createdAt: string | null }> = [];
    if (optedIn.size > 0) {
      const PER_PAGE = 1000;
      for (let page = 1; page <= 100; page++) {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
        if (error) throw error;
        const users = data?.users ?? [];
        for (const user of users) {
          if (optedIn.has(user.id) && user.email) accounts.push({ email: user.email, createdAt: user.created_at ?? null });
        }
        if (users.length < PER_PAGE) break;
      }
    }

    return mergeSubscriberDirectory({
      accounts,
      subscribers: subs.rows.map((row) => ({ email: row.email, source: row.source, optedInAt: row.opted_in_at, unsubscribedAt: row.unsubscribed_at })),
      suppressions: suppressions.rows.map((row) => ({ email: row.email, reason: row.reason, source: row.source, createdAt: row.created_at })),
      truncated: prefs.truncated || subs.truncated || suppressions.truncated,
    });
  } catch (error) {
    console.error("[admin-email] subscriber directory unavailable", error);
    return { rows: [], counts: { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 }, truncated: true };
  }
}
