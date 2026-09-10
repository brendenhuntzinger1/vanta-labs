import { getCustomerOrders } from "@/lib/customer-account";
import { getPointsHistory } from "@/lib/membership";
import { getMembershipBillingHistory } from "@/lib/membership-billing";
import { isUnpaid } from "@/lib/order-status";
import { customerSafeFailureReason } from "@/lib/safe-error";
import { displayOrderReference } from "@/lib/order-reference";

export type NotificationTone = "info" | "success" | "warning";
export interface AccountNotification {
  id: string;
  tone: NotificationTone;
  icon: "order" | "shipping" | "points" | "billing" | "alert";
  title: string;
  body: string | null;
  createdAt: string;
  href: string | null;
}

const POINTS_LABELS: Record<string, string> = {
  order_earn: "Points earned on your order",
  signup_bonus: "Welcome bonus added",
  referral_bonus: "Referral bonus added",
  birthday_bonus: "Happy birthday — bonus points added",
  redeem: "Points redeemed at checkout",
  order_refund_reversal: "Points adjusted for a refund",
  admin_adjustment: "Points adjusted",
};

// shortId used to name orders in this feed, and produced "order-31…f344" — an
// internal identifier the customer holds nowhere else. Every other surface (the
// orders list, the order detail heading, the confirmation page, the invoice and
// the emailed receipt) calls the same order "VL-CD07E93C", via
// displayOrderReference, which already falls back to a shortened id when an
// order genuinely has no number. So this feed now asks the same function, and
// shortId is gone rather than left as a second, divergent answer to the same
// question.

/**
 * A unified, honest notifications feed derived from the customer's real
 * activity — order status, points, and membership billing events. No separate
 * notifications table is required; everything here reflects data that already
 * exists. Sorted newest-first.
 */
export async function getCustomerNotifications(userId: string, email?: string | null, limit = 30): Promise<AccountNotification[]> {
  const [orders, points, billing] = await Promise.all([
    getCustomerOrders(userId, email).catch(() => []),
    getPointsHistory(userId, 20).catch(() => []),
    getMembershipBillingHistory(userId, 20).catch(() => []),
  ]);

  const items: AccountNotification[] = [];

  for (const order of orders.slice(0, 20)) {
    const ful = String(order.fulfillmentStatus ?? "").toLowerCase();
    const label = displayOrderReference(order.orderNumber, order.orderId);
    const orderHref = `/account/orders/${encodeURIComponent(order.orderId)}`;
    if (isUnpaid(order.paymentStatus)) {
      items.push({ id: `o-${order.orderId}`, tone: "warning", icon: "alert", title: `Finish paying for order ${label}`, body: "Your order is reserved but won't ship until payment is completed.", createdAt: order.createdAt, href: `/pay/${encodeURIComponent(order.orderId)}` });
    } else if (["delivered", "fulfilled"].includes(ful)) {
      items.push({ id: `o-${order.orderId}`, tone: "success", icon: "shipping", title: `Order ${label} delivered`, body: "Your order has arrived.", createdAt: order.createdAt, href: orderHref });
    } else if (["shipped", "out_for_delivery"].includes(ful)) {
      items.push({ id: `o-${order.orderId}`, tone: "info", icon: "shipping", title: `Order ${label} shipped`, body: order.trackingNumber ? `Tracking ${order.trackingNumber}` : "It's on the way.", createdAt: order.createdAt, href: orderHref });
    } else if (ful === "cancelled") {
      items.push({ id: `o-${order.orderId}`, tone: "warning", icon: "order", title: `Order ${label} cancelled`, body: null, createdAt: order.createdAt, href: orderHref });
    } else {
      items.push({ id: `o-${order.orderId}`, tone: "info", icon: "order", title: `Order ${label} confirmed`, body: "We're preparing your order.", createdAt: order.createdAt, href: orderHref });
    }
  }

  for (const entry of points) {
    if (entry.amount === 0) continue;
    const positive = entry.amount > 0;
    items.push({
      id: `p-${entry.id}`,
      tone: positive ? "success" : "info",
      icon: "points",
      title: POINTS_LABELS[entry.reason] ?? (positive ? "Points added" : "Points used"),
      body: `${positive ? "+" : ""}${entry.amount.toLocaleString()} points`,
      createdAt: entry.createdAt,
      href: "/account/rewards",
    });
  }

  for (const event of billing) {
    const failed = event.status === "failed";
    let title = "Membership update";
    let tone: NotificationTone = "info";
    if (event.eventType === "renewal") { title = "Membership renewed"; tone = failed ? "warning" : "success"; }
    else if (event.eventType === "payment_failed" || failed) { title = "Membership payment failed"; tone = "warning"; }
    else if (event.eventType === "cancellation") { title = "Membership cancelled"; tone = "info"; }
    else if (event.eventType === "pause") { title = "Membership paused"; tone = "info"; }
    else if (event.eventType === "resume") { title = "Membership resumed"; tone = "success"; }
    else if (event.eventType === "skip") { title = "Skipped a membership charge"; tone = "info"; }
    else if (event.eventType === "tier_change") { title = "Membership plan changed"; tone = "info"; }
    else if (event.eventType === "first_month_remainder") { title = "First-month balance charged"; tone = "success"; }

    items.push({
      id: `b-${event.id}`,
      tone,
      icon: failed ? "alert" : "billing",
      title,
      // SANITISED, the way the subscriptions page that shows the same value
      // already does it. This rendered the processor's raw failure string
      // verbatim to the customer — which carries decline codes, request ids and,
      // when the gateway is misconfigured, internal notes naming environment
      // variables. customerSafeFailureReason is the existing helper for exactly
      // this and returns null when nothing safe remains.
      body: failed ? customerSafeFailureReason(event.failureReason) : null,
      createdAt: event.createdAt,
      href: "/account/subscriptions",
    });
  }

  return items
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
