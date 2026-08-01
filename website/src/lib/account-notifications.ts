import { getCustomerOrders } from "@/lib/customer-account";
import { getPointsHistory } from "@/lib/membership";
import { getMembershipBillingHistory } from "@/lib/membership-billing";
import { isUnpaid } from "@/lib/order-status";

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

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

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
    const label = shortId(order.orderId);
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
      body: failed && event.failureReason ? event.failureReason : null,
      createdAt: event.createdAt,
      href: "/account/subscriptions",
    });
  }

  return items
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}
