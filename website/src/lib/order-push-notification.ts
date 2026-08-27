import "server-only";

import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getOrderProfit } from "@/lib/admin-profit";
import { recordSystemAlert } from "@/lib/monitoring";
import type { ProfitStatus } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// "You just got an order" — the operator's phone notification.
//
// One POST of flat JSON to an automation webhook (Zapier, Make, n8n; anything
// that accepts a JSON body), which forwards it to a push service. The webhook
// URL is the ONLY credential and it lives in ORDER_PUSH_WEBHOOK_URL, never in
// source: anyone holding it can fire fake "you got an order" alerts at the
// operator's phone, and a URL committed to git is a URL that cannot be rotated
// out of history.
//
// THREE RULES, all of which exist because this runs immediately after money has
// already changed hands:
//
//   1. IT NEVER THROWS. The order is paid, the customer has been charged, the
//      stock has moved. A dead webhook is an inconvenience; an exception here
//      that escaped into the payment webhook would be a lost side-effect run.
//   2. IT NEVER BLOCKS. Sent via after(), so it cannot add its latency to the
//      payment provider's callback — the failure mode that already broke this
//      codebase once, when a slow Shippo call pushed the webhook response past
//      the provider's timeout and left shoppers on "Processing…".
//   3. IT IS NOT A DELIVERY GUARANTEE. There is no retry and no queue. It is a
//      convenience alert; /admin/orders remains the authoritative record, and
//      nothing downstream may depend on this having been sent.
//
// Exactly-once is NOT this module's job. Both callers invoke it from inside an
// existing single-use claim (the card lane's paid_side_effects_at claim, the
// manual lane's conditional paid-flip), so a duplicate or replayed webhook
// delivery cannot double-notify.
// ---------------------------------------------------------------------------

/**
 * Well past a healthy webhook's response time, well short of the platform's
 * function limit. Zapier acknowledges a catch hook in well under a second; if
 * it has not answered in eight, waiting longer changes nothing.
 */
export const ORDER_PUSH_TIMEOUT_MS = 8_000;

export interface OrderPushInput {
  orderId: string;
  orderNumber: string | null;
  /** The customer's name as they typed it. Reduced before it is sent — see redactCustomerName. */
  customerName: string | null;
  /** What the customer actually paid, tax included. */
  total: number;
  /** Net profit, or null when it could not be computed. */
  profit: number | null;
  profitStatus: ProfitStatus | null;
  itemCount: number;
  placedAt: string;
  /** Public origin, used to build the admin deep link. */
  siteUrl: string | null;
}

/**
 * The wire contract. Flat strings only: every automation platform maps flat
 * string fields without a parsing step, and money as a string survives a
 * round-trip that would otherwise render 89.00 as "89".
 */
export interface OrderPushPayload {
  /** Lets one automation branch on the event rather than needing one per type. */
  event: "new_order";
  title: string;
  /** The whole notification, pre-assembled. Consumers should use this as-is. */
  message: string;
  order_number: string;
  order_id: string;
  customer: string;
  /** Plain number, no currency symbol, so a rule can filter on it numerically. */
  total: string;
  profit: string;
  profit_status: string;
  item_count: string;
  url: string;
  placed_at: string;
}

export type OrderPushResult =
  /** Delivered (the webhook answered 2xx). */
  | { sent: true }
  /** ORDER_PUSH_WEBHOOK_URL is unset — the feature is off. Not a failure. */
  | { sent: false; reason: "not_configured" }
  /** The configured URL is not https. Refused rather than sent in the clear. */
  | { sent: false; reason: "insecure_url" }
  /** No such order. */
  | { sent: false; reason: "order_not_found" }
  /** Timed out, refused, or answered non-2xx. */
  | { sent: false; reason: "delivery_failed"; detail: string };

/** "89" -> "89.00". Negative values keep their sign: "-12.30". */
function toAmount(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

/** "89" -> "$89.00"; "-12.3" -> "-$12.30" (a loss reads as a loss). */
function toDisplayMoney(value: number): string {
  const amount = Math.abs(Number.isFinite(value) ? value : 0).toFixed(2);
  return value < 0 ? `-$${amount}` : `$${amount}`;
}

/**
 * "Jordan Mitchell" -> "Jordan M."
 *
 * Enough for the operator to recognise the order at a glance; not enough to
 * accumulate a customer list in two third-party systems (the automation
 * platform's task history and the push service's message log) that no privacy
 * policy here covers. The order number is the real key, and the full record is
 * one tap away in /admin/orders.
 *
 * The given name is passed through EXACTLY as the customer typed it. Title-
 * casing would turn "o'brien" into "O'Brien" and "McDonald" into "Mcdonald" —
 * getting someone's own name wrong to make it look tidier. The only edit made
 * here is dropping the surname.
 */
export function redactCustomerName(raw: string | null | undefined): string {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  const surname = parts[parts.length - 1];
  return `${parts[0]} ${surname[0].toUpperCase()}.`;
}

export function buildOrderPushPayload(input: OrderPushInput): OrderPushPayload {
  const orderNumber = (input.orderNumber ?? "").trim();
  const customer = redactCustomerName(input.customerName);
  const siteUrl = (input.siteUrl ?? "").trim().replace(/\/+$/, "");
  const hasProfit = input.profit !== null && Number.isFinite(input.profit);

  // Every segment is optional except the order itself, so the message is
  // assembled from what is actually known rather than from a template with
  // holes in it. A missing profit costs the operator the profit, not the alert.
  const profitSegment = hasProfit
    ? `profit ${toDisplayMoney(input.profit as number)}${input.profitStatus === "estimated" ? " (est.)" : ""}`
    : "";

  const message = [
    `Order ${orderNumber || input.orderId}`,
    customer,
    toDisplayMoney(input.total),
    profitSegment,
  ]
    .filter(Boolean)
    .join(" — ");

  return {
    event: "new_order",
    title: "New Order",
    message,
    order_number: orderNumber,
    order_id: input.orderId,
    customer,
    total: toAmount(input.total),
    profit: hasProfit ? toAmount(input.profit as number) : "",
    profit_status: hasProfit ? input.profitStatus ?? "" : "",
    item_count: String(Math.max(0, Math.trunc(input.itemCount))),
    // An unset site URL would otherwise make the notification's tap target
    // "undefined/admin/orders/…". No link beats a broken one.
    url: siteUrl ? `${siteUrl}/admin/orders/${input.orderId}` : "",
    placed_at: input.placedAt,
  };
}

/** Gather what the notification needs. Never throws; missing parts degrade. */
async function collectOrderPushInput(orderId: string): Promise<OrderPushInput | null> {
  const [orderResult, itemsResult, profit] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_name, amount_paid, paid_at")
      .eq("order_id", orderId)
      .maybeSingle(),
    supabaseAdmin.from("order_items").select("quantity").eq("order_id", orderId),
    // Profit is the one part that reads several tables and applies settings, so
    // it is also the most likely to fail. It degrades to null on its own rather
    // than costing the operator the notification.
    getOrderProfit(orderId).catch(() => null),
  ]);

  const order = orderResult?.data as
    | { order_id?: string; order_number?: string | null; customer_name?: string | null; amount_paid?: number | null; paid_at?: string | null }
    | null
    | undefined;
  if (!order) return null;

  const items = (itemsResult?.data ?? []) as Array<{ quantity?: number | null }>;
  const itemCount = items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity ?? 0)), 0);

  return {
    orderId,
    orderNumber: order.order_number ?? null,
    customerName: order.customer_name ?? null,
    total: Number(order.amount_paid ?? 0),
    profit: profit ? profit.profit : null,
    profitStatus: profit ? profit.profitStatus : null,
    itemCount,
    placedAt: order.paid_at ?? new Date().toISOString(),
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
  };
}

/**
 * Send the paid-order notification. Resolves with the outcome and NEVER throws
 * — see rule 1 at the top of this file.
 */
export async function sendOrderPushNotification(orderId: string): Promise<OrderPushResult> {
  const webhookUrl = process.env.ORDER_PUSH_WEBHOOK_URL?.trim();

  // Unset is the default and is not a failure: no webhook configured, no
  // notifications, nothing logged. The feature ships dark until an operator
  // opts in by setting the variable.
  if (!webhookUrl) return { sent: false, reason: "not_configured" };

  // The URL is the only credential. Over http it — and every order that follows
  // — travels in the clear to anyone on the path, so this refuses rather than
  // downgrading silently. It is a configuration mistake, hence the alert.
  if (!webhookUrl.toLowerCase().startsWith("https://")) {
    await safeAlert("order_push_misconfigured", "ORDER_PUSH_WEBHOOK_URL is not an https:// URL. No notification was sent.");
    return { sent: false, reason: "insecure_url" };
  }

  try {
    const input = await collectOrderPushInput(orderId);
    if (!input) return { sent: false, reason: "order_not_found" };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOrderPushPayload(input)),
      signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = `webhook answered ${response.status}`;
      await safeAlert("order_push_failed", `Order ${orderId} notification not delivered: ${detail}`);
      return { sent: false, reason: "delivery_failed", detail };
    }

    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await safeAlert("order_push_failed", `Order ${orderId} notification not delivered: ${detail}`);
    return { sent: false, reason: "delivery_failed", detail };
  }
}

/**
 * Warning, never critical. Critical severity emails the operator, and emailing
 * someone to tell them a notification failed is both noise and a second thing
 * to go wrong. This lands on the admin status page, which is where a pattern of
 * failures is worth noticing.
 */
async function safeAlert(type: string, message: string): Promise<void> {
  try {
    await recordSystemAlert({ type, severity: "warning", message });
  } catch {
    // recordSystemAlert already swallows its own failures; this is belt and
    // braces so the alerting path can never be what breaks the alert.
  }
}

/**
 * Queue the notification to run after the response has been flushed.
 *
 * after() throws outside a request scope, and the paid lanes are reachable from
 * places that have none — the reconciliation sweep, a script, a test. There the
 * work is awaited inline instead: those callers are background jobs with nobody
 * waiting on the response, and a floating promise in a serverless function can
 * be killed with the process before it ever runs.
 */
export async function scheduleOrderPushNotification(orderId: string): Promise<void> {
  const run = async () => {
    try {
      await sendOrderPushNotification(orderId);
    } catch (error) {
      // sendOrderPushNotification does not throw. This is the guard for the day
      // someone edits it so that it does.
      console.error("Unable to send order push notification", orderId, error);
    }
  };

  try {
    after(run);
    return;
  } catch {
    // No request scope — fall through and run it inline.
  }

  await run();
}
