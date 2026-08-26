import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { loadConsentedAudience } from "@/lib/email/audience";
import { isSafeSitePath } from "@/lib/email/cta-path";
import { getSiteUrl } from "@/lib/env";
import { readAllRowsBounded } from "@/lib/supabase-page";

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
    readAllRowsBounded<{ attributed_campaign_id: string; payment_status: string; order_type: string | null; amount_paid: number | null; refund_amount: number | null }>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("attributed_campaign_id, payment_status, order_type, amount_paid, refund_amount")
        .not("attributed_campaign_id", "is", null)
        .order("attributed_campaign_id", { ascending: true })
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
