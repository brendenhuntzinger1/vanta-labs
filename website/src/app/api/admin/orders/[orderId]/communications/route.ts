import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { deriveOrderCommunications, type OrderEmailLogRow } from "@/lib/order-communications";
import { retryPendingEmailsForOrder } from "@/lib/email/retry-queue";
import { displayOrderReference } from "@/lib/order-reference";

/**
 * Read (GET) or retry (POST) the customer communications for one order.
 *
 * Read-only on GET. The POST does exactly one thing — re-send emails already
 * queued as failed for this order — and reaches no business logic to do it; see
 * retryPendingEmailsForOrder for why that is structural rather than a promise.
 */
async function loadOrder(orderId: string) {
  const { data } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, payment_status, fulfillment_status, shipped_at, delivered_at, customer_email")
    .eq("order_id", orderId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

async function loadCommunications(order: Record<string, unknown>) {
  const orderNumber = displayOrderReference(
    order.order_number as string | null,
    order.order_id as string | null,
  );

  // NULL means the read did not succeed; an empty array means it did and found
  // nothing. Those are different answers and the panel must not conflate them —
  // an unreadable queue rendered as "no failure recorded" would show a clean
  // bill of health at exactly the moment the system had gone blind.
  //
  // supabase-js reports a missing table through `error` rather than by
  // throwing, so the error object is checked explicitly. The catch covers the
  // transport failing outright.
  let pendingEmails:
    | { id: string; subject: string; status: string; attempts?: number | null; last_error?: string | null; updated_at?: string | null }[]
    | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("pending_emails")
      .select("id, subject, status, attempts, last_error, updated_at")
      .ilike("subject", `%${orderNumber}%`)
      .limit(20);
    if (!error) pendingEmails = (data ?? []) as NonNullable<typeof pendingEmails>;
  } catch {
    /* leave null — unreadable, which the panel reports as CANNOT DETERMINE */
  }

  // The only table that records a SUCCESSFUL send (E-07). Read separately, and
  // its failure is treated differently from the failure above on purpose: a
  // missing `pending_emails` hides failures and must show as CANNOT DETERMINE,
  // whereas a missing `order_email_log` only costs the panel the ability to
  // upgrade a clean row to SENT. So this one degrades to null and the panel
  // falls back to exactly what it said before the log existed.
  let emailLog: OrderEmailLogRow[] | null = null;
  try {
    const { data, error } = await supabaseAdmin
      .from("order_email_log")
      .select("kind, status, provider, provider_message_id")
      .eq("order_id", order.order_id as string)
      .limit(20);
    if (!error) emailLog = (data ?? []) as OrderEmailLogRow[];
  } catch {
    /* leave null — the panel simply cannot upgrade past "no failure recorded" */
  }

  return {
    orderNumber,
    paymentStatus: (order.payment_status as string) ?? null,
    fulfillmentStatus: (order.fulfillment_status as string) ?? null,
    shippedAt: (order.shipped_at as string) ?? null,
    deliveredAt: (order.delivered_at as string) ?? null,
    rows: deriveOrderCommunications({
      orderNumber,
      paymentStatus: (order.payment_status as string) ?? null,
      fulfillmentStatus: (order.fulfillment_status as string) ?? null,
      shippedAt: (order.shipped_at as string) ?? null,
      deliveredAt: (order.delivered_at as string) ?? null,
      pendingEmails,
      emailLog,
    }),
  };
}

export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });

  const { orderId } = await context.params;
  const order = await loadOrder(orderId);
  if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });

  return NextResponse.json(await loadCommunications(order), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });

  const { orderId } = await context.params;
  const order = await loadOrder(orderId);
  if (!order) return NextResponse.json({ error: "order not found" }, { status: 404 });

  const orderNumber = displayOrderReference(
    order.order_number as string | null,
    order.order_id as string | null,
  );
  const outcome = await retryPendingEmailsForOrder(orderNumber);

  // The refreshed view comes back with the result, so the panel reflects the
  // new state without a second round trip.
  return NextResponse.json(
    { ...outcome, ...(await loadCommunications(order)) },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
