import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isPaidOrderStatus, netOrderRevenue } from "@/lib/ledger";
import { loadConsentedAudience } from "@/lib/email/audience";

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
  opened: number;
  clicked: number;
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
  const [{ data: campaignRows }, { data: recipientRows }, { data: orderRows }] = await Promise.all([
    supabaseAdmin
      .from("email_campaigns")
      .select("id, name, subject, segment, segment_param, status, created_at, scheduled_at, completed_at, recipient_count")
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("email_campaign_recipients")
      .select("campaign_id, status, opened_at, clicked_at"),
    supabaseAdmin
      .from("orders")
      .select("attributed_campaign_id, payment_status, amount_paid, refund_amount")
      .not("attributed_campaign_id", "is", null),
  ]);

  type Tally = { sent: number; failed: number; suppressed: number; pending: number; opened: number; clicked: number };
  const tallies = new Map<string, Tally>();
  const blank = (): Tally => ({ sent: 0, failed: 0, suppressed: 0, pending: 0, opened: 0, clicked: 0 });

  for (const row of recipientRows ?? []) {
    const id = String(row.campaign_id ?? "");
    if (!id) continue;
    const tally = tallies.get(id) ?? blank();
    const status = String(row.status ?? "");
    if (status === "sent") tally.sent++;
    else if (status === "failed") tally.failed++;
    else if (status === "suppressed") tally.suppressed++;
    // 'claiming' is in flight, not a distinct outcome — counted as pending so
    // the numbers add up to the audience while a send is running.
    else tally.pending++;
    if (row.opened_at) tally.opened++;
    if (row.clicked_at) tally.clicked++;
    tallies.set(id, tally);
  }

  const revenueByCampaign = new Map<string, { orders: number; revenue: number }>();
  for (const row of orderRows ?? []) {
    if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
    const id = String(row.attributed_campaign_id ?? "");
    if (!id) continue;
    const entry = revenueByCampaign.get(id) ?? { orders: 0, revenue: 0 };
    entry.orders++;
    entry.revenue += netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null });
    revenueByCampaign.set(id, entry);
  }

  const campaigns: CampaignSummary[] = (campaignRows ?? []).map((row) => {
    const id = String(row.id);
    const tally = tallies.get(id) ?? blank();
    const money = revenueByCampaign.get(id) ?? { orders: 0, revenue: 0 };
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
  // Same-origin only. `//host` is the case that a naive "starts with /" check
  // lets through: browsers read it as protocol-relative and leave the site.
  if (!ctaPathRaw.startsWith("/") || ctaPathRaw.startsWith("//")) {
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
