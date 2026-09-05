import Link from "next/link";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import {
  getActivePointsMultiplier,
  getCustomerMembership,
  getPointsBalance,
  getPointsHistory,
  getProgressToNextReward,
  pointsToDollars,
  POINTS_PER_DOLLAR_REDEMPTION,
} from "@/lib/membership";
import { getActiveCouponsForDisplay } from "@/lib/coupons";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
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

export default async function AccountRewardsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const [membership, pointsBalance, pointsHistory, pointsMultiplier, activeCoupons] = await Promise.all([
    getCustomerMembership(user.id),
    // A points read that FAILED is not a balance of zero. Showing a confident
    // "0" on the rewards page told the customer their points were gone; null is
    // rendered as an unknown below instead.
    getPointsBalance(user.id).catch(() => null),
    getPointsHistory(user.id, 40).catch(() => []),
    getActivePointsMultiplier().catch(() => ({ multiplier: 1, eventName: null as string | null })),
    getActiveCouponsForDisplay().catch(() => []),
  ]);

  const progress = pointsBalance === null ? null : getProgressToNextReward(pointsBalance);

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Rewards</h1>
        <p className="mt-2 text-sm text-zinc-400">Earn points on every order and redeem them for money off at checkout.</p>
      </header>

      {/* Balance hero */}
      <section className="vl-panel overflow-hidden rounded-2xl p-5 sm:p-7">
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="rounded-xl border border-cyan-300/20 bg-gradient-to-br from-cyan-400/[0.12] to-transparent p-5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-cyan-200/70">Point balance</p>
            <p className="mt-2 text-4xl font-semibold text-white">{pointsBalance === null ? "—" : pointsBalance.toLocaleString("en-US")}</p>
            <p className="mt-1 text-sm text-zinc-400">
              {pointsBalance === null
                ? "Couldn't load right now — refresh in a moment."
                : `≈ ${money(pointsToDollars(pointsBalance))} in rewards`}
            </p>
          </div>
          <div className="vl-panel-soft rounded-xl p-5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Earn rate</p>
            <p className="mt-2 text-3xl font-semibold text-white">{membership.tier.pointsPerDollar}×</p>
            <p className="mt-1 text-sm text-zinc-500">
              points per $1{pointsMultiplier.multiplier > 1 ? ` · ${pointsMultiplier.eventName} (${pointsMultiplier.multiplier}× active)` : ""}
            </p>
          </div>
          <div className="vl-panel-soft rounded-xl p-5">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Redemption</p>
            <p className="mt-2 text-3xl font-semibold text-white">{POINTS_PER_DOLLAR_REDEMPTION} = $1</p>
            <p className="mt-1 text-sm text-zinc-500">applied at checkout</p>
          </div>
        </div>

        {progress === null ? null : (
          <div className="mt-6">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span className="font-medium text-zinc-300">Progress to your next reward</span>
              <span>{progress.pointsIntoMilestone} / {progress.milestone} pts</span>
            </div>
            <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-cyan-300 transition-[width] duration-500" style={{ width: `${progress.progressPercent}%` }} />
            </div>
          </div>
        )}
      </section>

      {activeCoupons.length > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Available coupons</h2>
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

      {/* History */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Points activity</h2>
        {pointsHistory.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-8 text-center">
            <p className="text-sm text-zinc-300">No activity yet</p>
            <p className="mx-auto mt-1.5 max-w-sm text-xs text-zinc-500">Place an order to start earning points — they&apos;ll show up here.</p>
            <Link href="/products" className="vl2-btn-secondary vl-focus-ring mt-5 inline-flex px-5 py-2.5 text-xs">Shop products</Link>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-white/10">
            {pointsHistory.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate text-zinc-200">{LEDGER_REASON_LABELS[entry.reason] ?? entry.reason}</p>
                  <p className="text-xs text-zinc-500">{new Date(entry.createdAt).toLocaleString("en-US")}</p>
                </div>
                <span className={entry.amount >= 0 ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                  {entry.amount >= 0 ? "+" : ""}{entry.amount.toLocaleString("en-US")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
