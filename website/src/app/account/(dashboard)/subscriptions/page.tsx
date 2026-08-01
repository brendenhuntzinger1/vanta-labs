import Link from "next/link";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerMembership } from "@/lib/membership";
import { getMembershipBillingHistory } from "@/lib/membership-billing";
import { MembershipBillingPanel } from "@/components/membership-billing-panel";
import { SubscriptionActions } from "@/components/subscription-actions";

export const dynamic = "force-dynamic";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const EVENT_LABELS: Record<string, string> = {
  renewal: "Renewal charge",
  first_month_remainder: "First-month balance",
  intro_charge: "Intro charge",
  payment_failed: "Payment failed",
  cancellation: "Cancellation",
  tier_change: "Plan change",
  pause: "Membership paused",
  resume: "Membership resumed",
  skip: "Skipped a charge",
};

export default async function AccountSubscriptionsPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const [membership, billingHistory] = await Promise.all([
    getCustomerMembership(user.id),
    getMembershipBillingHistory(user.id, 24).catch(() => []),
  ]);

  const isFree = membership.billingCycle === "free";
  const isActive = membership.status === "active" || membership.status === "trialing";
  const statusPill = membership.cancelAtPeriodEnd
    ? { text: "Ending at period end", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
    : membership.status === "paused"
      ? { text: "Paused", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
      : membership.status === "past_due"
        ? { text: "Payment needed", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
        : isActive
          ? { text: "Active", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" }
          : { text: membership.status.replace(/_/g, " "), cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300" };

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Subscription</h1>
        <p className="mt-2 text-sm text-zinc-400">Manage your membership plan, billing, and payment.</p>
      </header>

      {isFree ? (
        <section className="vl-panel rounded-2xl p-6 sm:p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-amber-200/25 bg-amber-200/[0.06] text-2xl">✦</div>
          <h2 className="mt-5 text-xl font-semibold text-white">You&apos;re on the free membership</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
            Upgrade to unlock member pricing, monthly store credit, faster points, and priority shipping.
          </p>
          <Link href="/membership" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-6 py-3 text-sm">View membership plans</Link>
        </section>
      ) : (
        <section className="vl-panel rounded-2xl p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Current plan</p>
              <h2 className="mt-1 text-2xl font-semibold text-white">{membership.tier.name}</h2>
              <p className="mt-1 text-sm capitalize text-zinc-400">{membership.billingCycle} billing</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${statusPill.cls}`}>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
              {statusPill.text}
            </span>
          </div>

          {/* Perk snapshot */}
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {membership.tier.memberDiscountPercent > 0 ? (
              <div className="vl-panel-soft rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Member pricing</p>
                <p className="mt-1.5 text-xl font-semibold text-white">{membership.tier.memberDiscountPercent}% off</p>
              </div>
            ) : null}
            {membership.tier.monthlyStoreCreditCents > 0 ? (
              <div className="vl-panel-soft rounded-xl p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Monthly credit</p>
                <p className="mt-1.5 text-xl font-semibold text-emerald-300">{money(membership.tier.monthlyStoreCreditCents)}/mo</p>
              </div>
            ) : null}
            <div className="vl-panel-soft rounded-xl p-4">
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Points</p>
              <p className="mt-1.5 text-xl font-semibold text-white">{membership.tier.pointsPerDollar}× per $1</p>
            </div>
          </div>

          {/* Billing + cancel controls (client) */}
          <MembershipBillingPanel membership={membership} />

          {/* Pause / skip / resume (monthly plans) */}
          <SubscriptionActions membership={{ status: membership.status, billingCycle: membership.billingCycle, cancelAtPeriodEnd: membership.cancelAtPeriodEnd }} />

          <div className="mt-4 flex flex-wrap gap-2.5">
            <Link href="/membership" className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">Change plan</Link>
          </div>
        </section>
      )}

      {/* Billing history */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Billing history</h2>
        {billingHistory.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No billing activity yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/10">
            {billingHistory.map((event) => {
              const failed = event.status === "failed";
              return (
                <li key={event.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-zinc-200">{EVENT_LABELS[event.eventType] ?? event.eventType.replace(/_/g, " ")}</p>
                    <p className="text-xs text-zinc-500">
                      {formatDate(event.createdAt)}
                      {failed && event.failureReason ? ` · ${event.failureReason}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {event.amountCents > 0 ? <p className="font-medium text-white">{money(event.amountCents)}</p> : null}
                    <span className={`text-[11px] ${failed ? "text-rose-300" : "text-emerald-300"}`}>{failed ? "Failed" : "Succeeded"}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-5 text-zinc-500">
          A payment processor isn&apos;t connected yet, so any scheduled charges currently resolve as pending/failed rather than being taken. You&apos;ll see real charges here once billing goes live.
        </p>
      </section>
    </div>
  );
}
