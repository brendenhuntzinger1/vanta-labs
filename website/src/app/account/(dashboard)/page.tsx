import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerOrders, getCustomerPreferences, getOrCreateReferralCode } from "@/lib/customer-account";
import {
  checkAndAwardBirthdayBonus,
  getActivePointsMultiplier,
  getCustomerMembership,
  getPointsBalance,
  getPointsHistory,
  getProgressToNextReward,
  getReferralEarnedPoints,
  pointsToDollars,
} from "@/lib/membership";
import { getActiveCouponsForDisplay } from "@/lib/coupons";
import { ReorderButton } from "@/components/reorder-button";
import { ReferralLinkCopyButton } from "@/components/referral-link-copy-button";
import { MembershipBillingPanel } from "@/components/membership-billing-panel";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const LEDGER_REASON_LABELS: Record<string, string> = {
  order_earn: "Order reward",
  order_refund_reversal: "Refund adjustment",
  redeem: "Redeemed at checkout",
  signup_bonus: "Welcome bonus",
  referral_bonus: "Referral bonus",
  birthday_bonus: "Birthday bonus",
  admin_adjustment: "Manual adjustment",
};

export default async function AccountDashboardPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer" || !user.email) {
    redirect("/account/login");
  }

  const preferences = await getCustomerPreferences(user.id);
  await checkAndAwardBirthdayBonus(user.id, preferences.birthday).catch(() => {});

  // `membership` is critical to the whole dashboard, so it stays uncaught. The
  // remaining queries degrade to safe defaults so one failing section doesn't
  // blank the entire page.
  const [orders, membership, pointsBalance, pointsHistory, referralEarnedPoints, referralCode, activeCoupons, pointsMultiplier] = await Promise.all([
    getCustomerOrders(user.email).catch(() => []),
    getCustomerMembership(user.id),
    getPointsBalance(user.id).catch(() => 0),
    getPointsHistory(user.id, 15).catch(() => []),
    getReferralEarnedPoints(user.id).catch(() => 0),
    getOrCreateReferralCode(user.id).catch(() => ""),
    getActiveCouponsForDisplay().catch(() => []),
    getActivePointsMultiplier().catch(() => ({ multiplier: 1, eventName: null })),
  ]);

  const progress = getProgressToNextReward(pointsBalance);
  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "";
  const referralPath = `/account/login?ref=${referralCode}`;
  const referralUrl = siteOrigin ? `${siteOrigin}${referralPath}` : referralPath;
  const hasShareableReferralLink = Boolean(siteOrigin && referralCode);

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Membership</p>
            <h1 className="mt-1 text-2xl font-semibold text-white">{membership.tier.name}</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {membership.billingCycle === "free"
                ? "Free membership"
                : `${membership.billingCycle === "annual" ? "Annual" : "Monthly"} plan, status: ${membership.status}${membership.renewsAt ? ` · renews ${new Date(membership.renewsAt).toLocaleDateString()}` : ""}`}
            </p>
          </div>
          <a href="/membership" className="vl-btn-secondary px-4 py-2 text-xs">
            {membership.tier.slug === "free" ? "Upgrade membership" : "Manage membership"}
          </a>
        </div>

        <MembershipBillingPanel membership={membership} />

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Point balance</p>
            <p className="mt-2 text-2xl font-semibold text-white">{pointsBalance.toLocaleString()}</p>
            <p className="mt-1 text-xs text-zinc-500">≈ {money(pointsToDollars(pointsBalance))} in rewards</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Earn rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{membership.tier.pointsPerDollar}x</p>
            <p className="mt-1 text-xs text-zinc-500">
              points per $1{pointsMultiplier.multiplier > 1 ? ` · ${pointsMultiplier.eventName} (${pointsMultiplier.multiplier}x active)` : ""}
            </p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Referral earnings</p>
            <p className="mt-2 text-2xl font-semibold text-white">{referralEarnedPoints.toLocaleString()} pts</p>
            <p className="mt-1 text-xs text-zinc-500">from referred sign-ups</p>
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Progress to next reward</span>
            <span>{progress.pointsIntoMilestone} / {progress.milestone} pts</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-cyan-400" style={{ width: `${progress.progressPercent}%` }} />
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Your referral link</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg bg-black/30 px-3 py-2 text-xs text-zinc-300">{referralUrl}</code>
            {hasShareableReferralLink ? <ReferralLinkCopyButton url={referralUrl} /> : null}
          </div>
          <p className="mt-2 text-xs text-zinc-500">Share this link — new customers who sign up get a bonus, and so do you.</p>
        </div>
      </section>

      {activeCoupons.length > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Available Coupons</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {activeCoupons.map((coupon) => (
              <span key={coupon.code} className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-zinc-200">
                <span className="font-mono font-semibold text-cyan-300">{coupon.code}</span>
                {" — "}
                {coupon.discountType === "fixed" ? money(coupon.discountValue) : `${coupon.discountValue}%`} off
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Reward History</h2>
        {pointsHistory.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-400">No point activity yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/10">
            {pointsHistory.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between py-2.5 text-sm">
                <div>
                  <p className="text-zinc-200">{LEDGER_REASON_LABELS[entry.reason] ?? entry.reason}</p>
                  <p className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString()}</p>
                </div>
                <span className={entry.amount >= 0 ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                  {entry.amount >= 0 ? "+" : ""}{entry.amount.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Your Orders</h2>
        <p className="mt-2 text-sm text-zinc-400">
          {orders.length} order{orders.length === 1 ? "" : "s"} placed with {user.email}.
        </p>
      </section>

      {orders.length === 0 ? (
        <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-400">
          No orders yet.
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <section key={order.orderId} className="vl-panel rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Order</p>
                  <p className="mt-1 break-all text-sm font-semibold text-white">{order.orderId}</p>
                  <p className="mt-1 text-xs text-zinc-500">{new Date(order.createdAt).toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-white">{money(order.amountPaid)}</p>
                  <p className="text-xs text-zinc-400">{statusLabel(order.paymentStatus)} • {statusLabel(order.fulfillmentStatus)}</p>
                  {order.trackingNumber ? (
                    <p className="mt-1 text-xs text-cyan-300">Tracking: {order.trackingNumber}</p>
                  ) : null}
                </div>
              </div>

              <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-4 text-sm text-zinc-300">
                {order.items.map((item, index) => (
                  <li key={`${order.orderId}-${index}`} className="flex justify-between gap-3">
                    <span>{item.productName} × {item.quantity}</span>
                    <span className="text-zinc-400">{money(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 border-t border-white/10 pt-4">
                <ReorderButton orderId={order.orderId} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
