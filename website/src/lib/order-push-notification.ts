import "server-only";

import { after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getOrderProfit } from "@/lib/admin-profit";
import { formatDisplayDate } from "@/lib/format-date";
import { recordSystemAlert } from "@/lib/monitoring";
import { getControlSnapshot } from "@/lib/admin-control";
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
// It does, however, SAY SO WHEN IT IS OFF. Two paid orders once went unannounced
// because ORDER_PUSH_WEBHOOK_URL was never set in production: the send returned
// `not_configured` without a word, so nothing on /admin/status reported that the
// phone had stopped ringing, and the gap was only found by reading the database.
// A feature that is silent when working and silent when broken cannot be told
// apart from one that is broken, so an unconfigured webhook now raises an alert
// (deduped to once a day — see ORDER_PUSH_UNCONFIGURED_DEDUPE_MS).
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

/** Pushover's message endpoint. A constant, so it can never be misconfigured. */
export const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

/**
 * Pushover's credential check. Confirms a token and user key are still valid and
 * SENDS NOTHING — which is the only reason a routine health check is possible.
 * A check that pushed to the owner's phone daily would be switched off inside a
 * week, and then the destination would be able to die quietly again.
 */
export const PUSHOVER_VALIDATE_URL = "https://api.pushover.net/1/users/validate.json";

/** How long an unhealthy-destination alert suppresses the next one. */
export const PUSH_HEALTH_DEDUPE_MS = 24 * 60 * 60 * 1000;

export type PushDestinationHealth = {
  kind: "pushover" | "webhook" | "none";
  /** true healthy, false broken, null genuinely unknown. */
  healthy: boolean | null;
  detail: string;
};

/**
 * Is the configured destination still able to receive an order?
 *
 * THE POINT IS TO LEARN THIS BEFORE AN ORDER NEEDS IT. The incident was not
 * that a webhook broke — webhooks break — it is that it broke silently and the
 * first evidence was a paid order nobody was told about.
 *
 * `healthy: null` for the webhook path is deliberate and is not a shrug. There
 * is no way to ping a Zapier Catch Hook that is not indistinguishable from a
 * fake order, so the honest answer is "cannot be checked", not a cheerful
 * "healthy" resting on no evidence. Saying so out loud is also the strongest
 * argument for moving to the Pushover path, which can be checked.
 */
export async function verifyPushDestination(): Promise<PushDestinationHealth> {
  const destination = await resolvePushDestination();

  if (destination.kind === "none") {
    return { kind: "none", healthy: false, detail: "No push destination is configured, so no order can be announced." };
  }

  if (destination.kind === "webhook") {
    return {
      kind: "webhook",
      healthy: null,
      detail: "A webhook cannot be checked without sending it something that looks like an order. "
        + "Configure Pushover directly to have this verified automatically.",
    };
  }

  try {
    const response = await fetch(PUSHOVER_VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: destination.token, user: destination.userKey }).toString(),
      signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as { status?: number; errors?: string[] } | null;

    if (response.ok && payload?.status === 1) {
      return { kind: "pushover", healthy: true, detail: "Pushover accepted the credentials." };
    }
    const errors = Array.isArray(payload?.errors) ? payload.errors.join("; ") : `answered ${response.status}`;
    return { kind: "pushover", healthy: false, detail: `Pushover rejected the credentials: ${errors}` };
  } catch (error) {
    // Unreachable is NOT healthy. Assuming the best is what let the last one
    // stay broken.
    return {
      kind: "pushover",
      healthy: false,
      detail: `Could not reach Pushover: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type TestPushResult = {
  sent: boolean;
  kind: "pushover" | "webhook" | "none";
  detail?: string;
};

/**
 * Deliver a real notification, on demand, from the Control Center.
 *
 * The scheduled check above answers "are these credentials still valid". It
 * cannot answer the question the owner actually asks after pasting a token in:
 * does a notification reach MY PHONE. Only a delivery answers that, and nobody
 * should have to place a real order to find out — that is precisely how the
 * last broken destination stayed broken.
 *
 * So this is the one path that pushes deliberately. Two things keep it from
 * becoming a nuisance of its own:
 *
 *  - The message says it is a test, in the title and the body. A phone alert
 *    that reads like money arriving, but is not, is worse than no test.
 *  - A failure is RETURNED, never alerted. Somebody is standing at the screen
 *    watching for the result; raising a critical (and emailing it) over their
 *    own experiment is how an alert feed becomes wallpaper. Contrast
 *    sendOrderPushNotification, where nobody is watching and the alert is the
 *    entire safety net.
 */
export async function sendTestPushNotification(): Promise<TestPushResult> {
  const destination = await resolvePushDestination();

  if (destination.kind === "none") {
    return {
      sent: false,
      kind: "none",
      detail: "No push destination is configured. Fill in the Pushover fields above (or a webhook URL) and save first.",
    };
  }

  if (destination.kind === "webhook" && !destination.url.toLowerCase().startsWith("https://")) {
    return {
      sent: false,
      kind: "webhook",
      detail: "The webhook URL must start with https:// — a real order would refuse it, so this test does too.",
    };
  }

  const title = "Vanta Labs test notification";
  const message = "This is a test from Admin -> Control Center -> Order Notifications. "
    + "If you are reading it on your phone, a real order will reach you the same way.";
  // Same source the order payload uses, trimmed the same way. Omitted rather
  // than sent as "undefined/admin/orders" when the site URL is not configured.
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  const url = siteUrl ? `${siteUrl}/admin/orders` : "";

  try {
    const response = destination.kind === "pushover"
      ? await fetch(PUSHOVER_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: destination.token,
            user: destination.userKey,
            title,
            message,
            ...(url ? { url, url_title: "Open the admin" } : {}),
          }).toString(),
          signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
        })
      : await fetch(destination.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The same field names a real order carries, so a webhook wired to
          // read `title`/`message` is exercised exactly as it will be used.
          body: JSON.stringify({ title, message, url, test: true }),
          signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
        });

    if (!response.ok) {
      return {
        sent: false,
        kind: destination.kind,
        detail: `The destination answered ${response.status}. The credentials or URL are wrong, or the app was deleted.`,
      };
    }
    return { sent: true, kind: destination.kind };
  } catch (error) {
    return {
      sent: false,
      kind: destination.kind,
      detail: `Could not reach the destination: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The cron entry point. Checks the destination and complains once a day if it
 * has gone bad, so a revoked token surfaces on its own rather than at the cost
 * of the next order.
 *
 * Never throws: it runs beside ten other jobs in a shared 60-second window.
 */
export async function runOrderPushHealthCheck(): Promise<PushDestinationHealth> {
  let health: PushDestinationHealth;
  try {
    health = await verifyPushDestination();
  } catch (error) {
    health = {
      kind: "none",
      healthy: false,
      detail: `Could not check the push destination: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Only a definite NO raises. `null` means unverifiable, and alerting daily on
  // something nobody can act on is how a status page becomes wallpaper.
  if (health.healthy === false) {
    await safeAlert(
      "order_push_destination_unhealthy",
      `Order push notifications will NOT reach you: ${health.detail} `
        + "Fix this in Admin -> Control Center -> Order Notifications before the next order.",
      PUSH_HEALTH_DEDUPE_MS,
    );
  }

  return health;
}

/**
 * How long an "the webhook is not configured" alert suppresses the next one.
 * The condition is a standing configuration fault, not an event: it is equally
 * true of every order placed until someone fixes it, so one row a day says it
 * without burying the rest of /admin/status on a busy day.
 */
export const ORDER_PUSH_UNCONFIGURED_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** Long enough for any real name; short enough that one cannot fill the screen. */
const MAX_CUSTOMER_NAME_CHARS = 80;
/** Product names are long ("Alpha Peptide 10mg — 2 Vial Bundle"); the alert is not. */
const MAX_ITEM_NAME_CHARS = 40;
/**
 * Pushover truncates a long message, and a truncated one drops the lines at the
 * BOTTOM — which is where the profit and the time live. Capping the item list
 * keeps a 30-line wholesale order from costing the operator everything else.
 */
const MAX_ITEMS_LISTED = 4;

/** One line of the order, as it will be read on a phone. */
export interface OrderPushItem {
  name: string | null;
  quantity: number;
}

export interface OrderPushInput {
  orderId: string;
  orderNumber: string | null;
  /** The customer's name as they typed it. Sent in full — see formatCustomerName. */
  customerName: string | null;
  /** What the customer actually paid, tax included. */
  total: number;
  /** Net profit, or null when it could not be computed. */
  profit: number | null;
  profitStatus: ProfitStatus | null;
  itemCount: number;
  /** What was actually bought. Empty when the lines could not be read. */
  items: OrderPushItem[];
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
  /** Carries the order number: a phone shows the title first and in bold. */
  title: string;
  /** The body, pre-assembled and multi-line. Consumers should use this as-is. */
  message: string;
  order_number: string;
  order_id: string;
  /** The customer's full name. */
  customer: string;
  /** Plain number, no currency symbol, so a rule can filter on it numerically. */
  total: string;
  profit: string;
  profit_status: string;
  item_count: string;
  /** "2× Alpha Peptide 10mg, 1× Bac Water 30ml". Capped — see MAX_ITEMS_LISTED. */
  items: string;
  url: string;
  /** Machine-readable instant (UTC), for a Zap that needs to compare times. */
  placed_at: string;
  /** The same instant for a human, in the store's zone: "Aug 28, 2026, 1:50 PM ET". */
  placed_at_display: string;
}

export type OrderPushResult =
  /** Delivered (the webhook answered 2xx). */
  | { sent: true }
  /** ORDER_PUSH_WEBHOOK_URL is unset, so nothing was sent. Raises an alert. */
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

/** "…" rather than a hard cut, so a shortened value looks shortened. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The customer's name, in full.
 *
 * This used to reduce "Jordan Mitchell" to "Jordan M." to keep a customer list
 * out of the two third-party logs this payload passes through (the automation
 * platform's task history and the push service's message log). The operator
 * asked for the full name instead: they are the only reader, and a first name
 * plus an initial is not enough to tell two orders apart at a glance.
 *
 * That trade is deliberate and bounded — the name is ALL that is added. The
 * email address and the shipping address still have nowhere to live in
 * OrderPushPayload, and a test asserts their absence so adding one stays a
 * decision rather than an accident.
 *
 * The name is passed through EXACTLY as the customer typed it, beyond
 * collapsing runs of whitespace. Title-casing would turn "o'brien" into
 * "O'Brien" and "McDonald" into "Mcdonald" — getting someone's own name wrong
 * to make it look tidier. The old initialling did worse: it assumed the first
 * word was a given name and the last a surname, so "Private Lillian Hanze"
 * reached the phone as "Private H.".
 */
export function formatCustomerName(raw: string | null | undefined): string {
  const collapsed = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!collapsed) return "";
  return clamp(collapsed, MAX_CUSTOMER_NAME_CHARS);
}

/**
 * "2× Alpha Peptide 10mg, 1× Bac Water 30ml", or "" when nothing is known.
 *
 * A line with no product name is dropped rather than printed as "2× undefined":
 * a missing name is a data problem, and repeating it on the operator's phone
 * helps nobody. Past MAX_ITEMS_LISTED the rest collapse into "+N more".
 */
export function formatOrderItems(items: readonly OrderPushItem[]): string {
  const named = items
    .map((item) => ({
      name: (item.name ?? "").trim().replace(/\s+/g, " "),
      quantity: Math.max(0, Math.trunc(Number(item.quantity ?? 0))),
    }))
    .filter((item) => item.name !== "" && item.quantity > 0);

  if (named.length === 0) return "";

  const listed = named
    .slice(0, MAX_ITEMS_LISTED)
    .map((item) => `${item.quantity}× ${clamp(item.name, MAX_ITEM_NAME_CHARS)}`);

  const remaining = named.length - MAX_ITEMS_LISTED;
  if (remaining > 0) listed.push(`+${remaining} more`);

  return listed.join(", ");
}

export function buildOrderPushPayload(input: OrderPushInput): OrderPushPayload {
  const orderNumber = (input.orderNumber ?? "").trim();
  const customer = formatCustomerName(input.customerName);
  const items = formatOrderItems(input.items ?? []);
  const siteUrl = (input.siteUrl ?? "").trim().replace(/\/+$/, "");
  const hasProfit = input.profit !== null && Number.isFinite(input.profit);

  // Every segment is optional except the money, so the message is assembled
  // from what is actually known rather than from a template with holes in it.
  // A missing profit costs the operator the profit, not the alert.
  const profitSegment = hasProfit
    ? `profit ${toDisplayMoney(input.profit as number)}${input.profitStatus === "estimated" ? " (est.)" : ""}`
    : "";

  // The store's zone, never the server's: Vercel runs UTC, so an unpinned
  // format reports a 9pm Eastern order as having happened tomorrow. Empty
  // rather than "Invalid Date" when the timestamp cannot be read.
  const placedAtDisplay = formatDisplayDate(input.placedAt, "datetime");
  const placedAt = placedAtDisplay ? `${placedAtDisplay} ET` : "";

  // One fact per line. A phone renders these stacked, so the operator reads
  // who / what / what it earned / when without opening anything. The order
  // number rides in the title, except when there is none to ride — then the id
  // leads the body, because an alert nobody can trace to an order is noise.
  const message = [
    orderNumber ? "" : `Order ${input.orderId}`,
    [customer, toDisplayMoney(input.total)].filter(Boolean).join(" — "),
    items,
    profitSegment,
    placedAt,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    event: "new_order",
    title: orderNumber ? `New Order ${orderNumber}` : "New Order",
    message,
    order_number: orderNumber,
    order_id: input.orderId,
    customer,
    total: toAmount(input.total),
    profit: hasProfit ? toAmount(input.profit as number) : "",
    profit_status: hasProfit ? input.profitStatus ?? "" : "",
    item_count: String(Math.max(0, Math.trunc(input.itemCount))),
    items,
    // An unset site URL would otherwise make the notification's tap target
    // "undefined/admin/orders/…". No link beats a broken one.
    url: siteUrl ? `${siteUrl}/admin/orders/${input.orderId}` : "",
    placed_at: input.placedAt,
    placed_at_display: placedAt,
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
    supabaseAdmin.from("order_items").select("product_name, quantity").eq("order_id", orderId),
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

  const items = (itemsResult?.data ?? []) as Array<{ product_name?: string | null; quantity?: number | null }>;
  const itemCount = items.reduce((sum, item) => sum + Math.max(0, Number(item.quantity ?? 0)), 0);

  return {
    orderId,
    orderNumber: order.order_number ?? null,
    customerName: order.customer_name ?? null,
    total: Number(order.amount_paid ?? 0),
    profit: profit ? profit.profit : null,
    profitStatus: profit ? profit.profitStatus : null,
    itemCount,
    items: items.map((item) => ({ name: item.product_name ?? null, quantity: Number(item.quantity ?? 0) })),
    placedAt: order.paid_at ?? new Date().toISOString(),
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null,
  };
}

/**
 * Send the paid-order notification. Resolves with the outcome and NEVER throws
 * — see rule 1 at the top of this file.
 */
/**
 * Where a paid order gets announced.
 *
 * TWO DESTINATIONS, AND THE SHORTER ONE WINS. Pushover is the actual phone
 * notification service; the webhook path reaches it through an automation tool
 * (Zapier) that forwards the payload on. That middleman is what failed: the
 * Catch Hook stopped existing, answered 404, and a paid order went unannounced.
 * Talking to Pushover directly removes a whole service from the path.
 *
 * BOTH ARE READ FROM THE CONTROL CENTER FIRST, environment second. The other
 * half of that incident was that the dead URL lived in an environment variable,
 * so correcting it required a redeploy — at exactly the moment orders were
 * being missed. From the admin it is a ten-second edit. That is the wrong
 * default for most configuration and the right one for the setting whose whole
 * job is to still work when something else has broken.
 */
type PushDestination =
  | { kind: "pushover"; token: string; userKey: string }
  | { kind: "webhook"; url: string }
  | { kind: "none" };

async function resolvePushDestination(): Promise<PushDestination> {
  let configured: Record<string, unknown> = {};
  try {
    const snapshot = await getControlSnapshot("notifications");
    configured = snapshot.notifications ?? {};
  } catch {
    // A settings read failure must never be the reason an order goes
    // unannounced. Fall through to the environment.
  }

  const text = (value: unknown) => String(value ?? "").trim();
  const token = text(configured.pushover_token);
  const userKey = text(configured.pushover_user_key);

  // BOTH keys or neither. A half-filled pair is a configuration mistake, and
  // posting with one of them would fail at Pushover while looking configured.
  if (token && userKey) return { kind: "pushover", token, userKey };

  const url = text(configured.order_push_webhook_url) || text(process.env.ORDER_PUSH_WEBHOOK_URL);
  return url ? { kind: "webhook", url } : { kind: "none" };
}

export async function sendOrderPushNotification(orderId: string): Promise<OrderPushResult> {
  const destination = await resolvePushDestination();
  const webhookUrl = destination.kind === "webhook" ? destination.url : undefined;

  /**
   * The order was paid and NOT announced. Raise it as a critical, which the
   * alerting path emails to the operator.
   *
   * THE MESSAGE IS THE NOTIFICATION, NOT A MESSAGE ABOUT ONE. The comment on
   * safeAlert below argues — correctly — that emailing someone to say "a
   * notification failed" is noise and a second thing to go wrong. So this does
   * not do that. It carries the same text the phone would have shown, plus the
   * reason it had to arrive this way, so the email IS the missed notification
   * on a different channel.
   *
   * That distinction was learned the expensive way: on 2026-09-01 a real
   * $94.96 order was paid, the webhook answered 404, and the only trace was a
   * warning on a status page nobody was watching.
   *
   * PER ORDER, NEVER DEDUPED. Two missed orders are two facts, and collapsing
   * them loses one.
   *
   * DELIVERY FAILURES ONLY — deliberately NOT the unconfigured or insecure-URL
   * paths. Those are STANDING CONFIGURATION faults: the store has never had
   * push, the operator is not waiting for it, and the daily-deduped warning
   * above is the right signal to go and set it up. Raising a critical per order
   * there would mail the operator for every order of a state they already know
   * about, which is the nagging the dedupe on those alerts exists to prevent.
   *
   * A webhook that WAS configured and has started failing is the opposite case,
   * and the one that actually cost an order: everything looks set up, so
   * nothing prompts anybody to look.
   */
  const announceMissedOrder = async (reason: string) => {
    let summary = `Order ${orderId}`;
    try {
      const input = await collectOrderPushInput(orderId);
      if (input) {
        const payload = buildOrderPushPayload(input);
        const link = payload.url ? `\n${payload.url}` : "";
        summary = `${payload.title}\n${payload.message}${link}`;
      }
    } catch {
      // The push already failed; a second failure reading the order must not
      // cost the operator the alert as well. The id alone is still actionable.
    }

    await safeAlert(
      "order_notification_missed",
      `${summary}\n\nThis order was PAID but the push notification did not go out (${reason}). `
        + "It is in the admin and needs fulfilling. Fix the push webhook so the next one reaches your phone.",
    );
  };

  // A paid order just arrived and there is nowhere to announce it. This used to
  // return in silence, which is how two real orders went unannounced without
  // anything anywhere saying so. Deduped to one row a day: the fault is a
  // standing one, so every order after the first repeats it rather than adding
  // to it.
  if (destination.kind === "none") {
    await safeAlert(
      "order_push_not_configured",
      `Order ${orderId} was paid but no push notification was sent: ORDER_PUSH_WEBHOOK_URL is unset. ` +
        "No paid order is being announced until it is set in the production environment.",
      ORDER_PUSH_UNCONFIGURED_DEDUPE_MS,
    );
    return { sent: false, reason: "not_configured" };
  }

  // The URL is the only credential. Over http it — and every order that follows
  // — travels in the clear to anyone on the path, so this refuses rather than
  // downgrading silently. It is a configuration mistake, hence the alert.
  if (destination.kind === "webhook" && !destination.url.toLowerCase().startsWith("https://")) {
    await safeAlert("order_push_misconfigured", "ORDER_PUSH_WEBHOOK_URL is not an https:// URL. No notification was sent.");
    return { sent: false, reason: "insecure_url" };
  }

  try {
    const input = await collectOrderPushInput(orderId);
    if (!input) return { sent: false, reason: "order_not_found" };

    const payload = buildOrderPushPayload(input);

    // Pushover takes form-encoded fields, not JSON, and its own title/message/
    // url map one-to-one onto the payload the webhook already carries — so both
    // destinations announce exactly the same four facts.
    const response = destination.kind === "pushover"
      ? await fetch(PUSHOVER_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: destination.token,
            user: destination.userKey,
            title: payload.title,
            message: payload.message,
            ...(payload.url ? { url: payload.url, url_title: "Open in admin" } : {}),
          }).toString(),
          signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
        })
      : await fetch(webhookUrl as string, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(ORDER_PUSH_TIMEOUT_MS),
        });

    if (!response.ok) {
      const detail = `webhook answered ${response.status}`;
      await safeAlert("order_push_failed", `Order ${orderId} notification not delivered: ${detail}`);
      await announceMissedOrder(detail);
      return { sent: false, reason: "delivery_failed", detail };
    }

    return { sent: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await safeAlert("order_push_failed", `Order ${orderId} notification not delivered: ${detail}`);
    await announceMissedOrder(detail);
    return { sent: false, reason: "delivery_failed", detail };
  }
}

/**
 * Warning, never critical. Critical severity emails the operator, and emailing
 * someone to tell them a notification failed is both noise and a second thing
 * to go wrong. This lands on the admin status page, which is where a pattern of
 * failures is worth noticing.
 */
async function safeAlert(type: string, message: string, dedupeWindowMs?: number): Promise<void> {
  try {
    // `order_notification_missed` is the one critical here, because it is the
    // only one that carries an order the operator has not been told about.
    // Everything else describes the CONFIGURATION, which belongs on the status
    // page rather than in an inbox.
    const severity = type === "order_notification_missed" || type === "order_push_destination_unhealthy"
      ? "critical"
      : "warning";
    await recordSystemAlert({ type, severity, message, dedupeWindowMs });
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
