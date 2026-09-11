import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isInternalAddressHere } from "@/lib/email/internal-addresses";
import {
  buildLifecycleFunnel,
  type FunnelCartRow,
  type FunnelDeliveryRow,
  type FunnelEngagementRow,
  type FunnelOrderItemRow,
  type FunnelOrderRow,
  type FunnelSendRow,
  type LifecycleFunnelReport,
} from "@/lib/email/lifecycle-funnel";

/**
 * THE LOADER BEHIND THE LIFECYCLE FUNNEL. Reads the rows, hands them to the
 * pure builder, and never throws: an admin page that cannot show a funnel
 * still has to show everything else, and a funnel that fails to load says so
 * rather than showing zeroes that look like a quiet month.
 *
 * WHAT IS READ, AND WHY THE WINDOW IS WIDER THAN IT LOOKS. Sends, delivery
 * events, engagement events and paid orders inside the window; every cart
 * created inside it (that is the eligibility count) plus any cart a send in
 * the window refers to, because a sequence can straddle the boundary; and
 * the order lines of orders the store credited to a flow, for cost of goods.
 * Engagement is read from slightly before the window so a send on day one
 * whose open arrived within the hour is not missed on a boundary.
 *
 * Every read is paged. Supabase silently caps an unpaged read at 1,000 rows,
 * and a funnel built on a silent prefix is the worst kind of wrong.
 */

export interface LifecycleFunnelResult extends LifecycleFunnelReport {
  ok: boolean;
  error?: string;
  truncated: boolean;
}

const PAGE = 1_000;
const MAX_ROWS = 50_000;
const IN_CHUNK = 150;

type Query = { range(lo: number, hi: number): PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }> };

async function readPaged<T>(build: () => Query, label: string): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let lo = 0; lo < MAX_ROWS; lo += PAGE) {
    const { data, error } = await build().range(lo, lo + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message ?? "read failed"}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function readByIds<T>(table: string, column: string, select: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin.from(table).select(select).in(column, ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`${table} read: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export function emptyLifecycleFunnel(windowDays: number, error?: string): LifecycleFunnelResult {
  return { ok: !error, error, truncated: false, windowDays, rows: [], notes: [] };
}

export async function getLifecycleFunnel(windowDays = 28): Promise<LifecycleFunnelResult> {
  const now = Date.now();
  const since = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const engagementSince = new Date(now - (windowDays + 1) * 24 * 60 * 60 * 1000).toISOString();
  const notes: string[] = [];
  let truncated = false;

  try {
    const sendsRead = await readPaged<{
      campaign_type: string; reference_id: string | null; recipient_email: string | null;
      sent_at: string; provider_message_id: string | null; status: string | null;
    }>(() => supabaseAdmin
      .from("email_send_log")
      .select("campaign_type, reference_id, recipient_email, sent_at, provider_message_id, status")
      .gte("sent_at", since)
      .order("sent_at", { ascending: true }) as unknown as Query, "send log");
    truncated ||= sendsRead.truncated;
    const sends: FunnelSendRow[] = sendsRead.rows.map((r) => ({
      campaignType: String(r.campaign_type ?? ""),
      referenceId: r.reference_id ?? null,
      recipientEmail: r.recipient_email ?? null,
      sentAt: String(r.sent_at ?? ""),
      providerMessageId: r.provider_message_id ?? null,
      status: String(r.status ?? ""),
    }));

    const deliveriesRead = await readPaged<{ provider_message_id: string | null; kind: string; received_at: string }>(
      () => supabaseAdmin
        .from("email_delivery_events")
        .select("provider_message_id, kind, received_at")
        .in("kind", ["delivered", "hard_bounce", "soft_bounce"])
        .gte("received_at", since)
        .order("received_at", { ascending: true }) as unknown as Query, "delivery events");
    truncated ||= deliveriesRead.truncated;
    const deliveries: FunnelDeliveryRow[] = deliveriesRead.rows.map((r) => ({
      providerMessageId: r.provider_message_id ?? null, kind: String(r.kind ?? ""), receivedAt: String(r.received_at ?? ""),
    }));

    // The engagement table ships with this reporting layer. Before the
    // migration is applied the read fails, and the funnel still renders with
    // the fact stated rather than with every open counted as nobody.
    let engagements: FunnelEngagementRow[] = [];
    try {
      const engagementsRead = await readPaged<{
        campaign_type: string; reference_id: string | null; recipient_email: string | null;
        kind: "opened" | "clicked"; at: string; user_agent: string | null;
      }>(() => supabaseAdmin
        .from("email_engagement_events")
        .select("campaign_type, reference_id, recipient_email, kind, at, user_agent")
        .gte("at", engagementSince)
        .order("at", { ascending: true }) as unknown as Query, "engagement events");
      truncated ||= engagementsRead.truncated;
      engagements = engagementsRead.rows.map((r) => ({
        campaignType: String(r.campaign_type ?? ""), referenceId: r.reference_id ?? null, recipientEmail: r.recipient_email ?? null,
        kind: r.kind, at: String(r.at ?? ""), userAgent: r.user_agent ?? null,
      }));
    } catch (error) {
      notes.push(`Engagement events unavailable (${error instanceof Error ? error.message : String(error)}); opens and clicks show as none until the lifecycle-measurement migration is applied.`);
    }

    const cartsRead = await readPaged<{ id: string; email: string | null; first_seen_at: string; restored_at: string | null; checkout_started_at: string | null }>(
      () => supabaseAdmin
        .from("abandoned_carts")
        .select("id, email, first_seen_at, restored_at, checkout_started_at")
        .gte("created_at", since)
        .order("created_at", { ascending: true }) as unknown as Query, "carts");
    truncated ||= cartsRead.truncated;
    const cartIds = new Set(cartsRead.rows.map((r) => String(r.id)));
    const referenced = [...new Set(sends
      .filter((s) => s.campaignType.startsWith("cart_recovery_") && s.referenceId && !cartIds.has(s.referenceId))
      .map((s) => String(s.referenceId)))];
    const straddling = referenced.length > 0
      ? await readByIds<{ id: string; email: string | null; first_seen_at: string; restored_at: string | null; checkout_started_at: string | null }>(
        "abandoned_carts", "id", "id, email, first_seen_at, restored_at, checkout_started_at", referenced)
      : [];
    // Carts created before the window are not eligible in it, but their
    // restores and orders still belong to the sends that earned them.
    const carts: FunnelCartRow[] = [...cartsRead.rows, ...straddling].map((r) => ({
      id: String(r.id), email: String(r.email ?? ""), firstSeenAt: String(r.first_seen_at ?? ""),
      restoredAt: r.restored_at ?? null, checkoutStartedAt: r.checkout_started_at ?? null,
    }));
    const eligibleCartIds = cartIds;

    const ordersRead = await readPaged<{
      order_id: string; customer_email: string | null; paid_at: string | null; created_at: string;
      amount_paid: number | null; refund_amount: number | null; discount_amount: number | null;
      marketing_source_kind: string | null; marketing_source_ref: string | null;
      payment_status: string; order_type: string | null; replacement_of: string | null;
    }>(() => supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, paid_at, created_at, amount_paid, refund_amount, discount_amount, marketing_source_kind, marketing_source_ref, payment_status, order_type, replacement_of")
      .gte("created_at", since)
      .order("created_at", { ascending: true }) as unknown as Query, "orders");
    truncated ||= ordersRead.truncated;
    const orders: FunnelOrderRow[] = ordersRead.rows.map((r) => ({
      orderId: String(r.order_id), email: String(r.customer_email ?? "").toLowerCase(),
      paidAt: String(r.paid_at ?? r.created_at ?? ""),
      amountPaid: Number(r.amount_paid ?? 0), refundAmount: Number(r.refund_amount ?? 0), discountAmount: Number(r.discount_amount ?? 0),
      marketingSourceKind: r.marketing_source_kind ?? null, marketingSourceRef: r.marketing_source_ref ?? null,
      paymentStatus: String(r.payment_status ?? ""), orderType: r.order_type ?? null, replacementOf: r.replacement_of ?? null,
    }));

    const creditedOrderIds = orders
      .filter((o) => o.marketingSourceKind === "cart_recovery" || o.marketingSourceKind === "automation" || o.marketingSourceKind === "campaign")
      .map((o) => o.orderId);
    const items = creditedOrderIds.length > 0
      ? await readByIds<{ order_id: string; unit_cost_cents: number | null; quantity: number | null }>("order_items", "order_id", "order_id, unit_cost_cents, quantity", creditedOrderIds)
      : [];
    const orderItems: FunnelOrderItemRow[] = items.map((r) => ({
      orderId: String(r.order_id), unitCostCents: Number(r.unit_cost_cents ?? 0), quantity: Number(r.quantity ?? 0),
    }));

    const report = buildLifecycleFunnel({
      now, windowDays, isInternal: isInternalAddressHere,
      sends, deliveries, engagements, carts, orders, orderItems,
    });
    // The builder counts every non-internal cart it is given as eligible, and
    // it was given the straddling carts for their outcomes. Only carts created
    // inside the window entered it, so eligibility is narrowed to those here.
    const total = report.rows.find((r) => r.flow === "cart_recovery" && r.stage === "all");
    if (total) {
      total.eligible = carts.filter((c) => eligibleCartIds.has(c.id) && !isInternalAddressHere(c.email)).length;
    }
    if (truncated) notes.push("One or more reads hit the row ceiling; the figures understate.");
    return { ...report, notes: [...notes, ...report.notes], ok: true, truncated };
  } catch (error) {
    return emptyLifecycleFunnel(windowDays, error instanceof Error ? error.message : String(error));
  }
}
