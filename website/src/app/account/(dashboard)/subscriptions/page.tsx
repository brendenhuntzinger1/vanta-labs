import Link from "next/link";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerMembership, getMembershipPerks } from "@/lib/membership";
import { isPaidBillingEvent } from "@/lib/membership-status";
import { customerSafeFailureReason } from "@/lib/safe-error";
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

  const [membership, perks, billingHistory] = await Promise.all([
    getCustomerMembership(user.id),
    getMembershipPerks(user.id),
    getMembershipBillingHistory(user.id, 24).catch(() => []),
  ]);

  // Three distinct states, and the difference matters. A paid-cycle row is NOT
  // the same as a working membership: a failed renewal leaves billingCycle
  // "monthly" with status "past_due", and gating on billingCycle alone (as this
  // page used to) rendered the full plan card, live perk figures, and pause/skip
  // controls for an account receiving none of it — while the pill next to it
  // read "Payment needed". `perks.isActiveMember` is the same gate the checkout
  // and points paths use, so what this page claims and what the buyer actually
  // gets can no longer disagree.
  const isActiveMember = perks.isActiveMember;
  const hasPaidPlan = membership.billingCycle !== "free";
  const isLapsed = hasPaidPlan && !isActiveMember;

  const statusPill = !hasPaidPlan
    ? { text: "Free membership", cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300" }
    : membership.status === "past_due"
      ? { text: "Payment needed", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
      : membership.status === "paused"
        ? { text: "Paused", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
        : membership.status === "cancelled"
          ? { text: "Canceled", cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300" }
          : isLapsed
            ? { text: "Expired", cls: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300" }
            // An ANNUAL membership carries cancel_at_period_end BY DESIGN — it is
            // a one-year pass that never auto-renews. Showing "Ending at period
            // end" would alarm a member whose plan is behaving exactly as sold.
            // Only a MONTHLY plan winding down is genuinely "ending".
            : membership.cancelAtPeriodEnd && membership.billingCycle !== "annual"
              ? { text: "Ending at period end", cls: "border-amber-300/40 bg-amber-300/10 text-amber-200" }
              : { text: "Active", cls: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200" };

  const lapsedCopy =
    membership.status === "past_due"
      ? {
          heading: "We couldn't process your last payment",
          body: "Your member benefits are paused until a payment goes through. Update your card to restore them — nothing is charged until it succeeds.",
          cta: "Update payment method",
        }
      : membership.status === "paused"
        ? {
            heading: "Your membership is paused",
            body: "Benefits are off while your plan is paused. Resume any time to turn them back on.",
            cta: "Resume membership",
          }
        : {
            heading: "Your membership has ended",
            body: "Member pricing, store credit, and bonus points are no longer applied to your orders. Rejoin any time.",
            cta: "View membership plans",
          };

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Subscription</h1>
        <p className="mt-2 text-sm text-zinc-400">Manage your membership plan, billing, and payment.</p>
      </header>

      {!hasPaidPlan ? (
        <section className="vl-panel rounded-2xl p-6 sm:p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-amber-200/25 bg-amber-200/[0.06] text-2xl">✦</div>
          <h2 className="mt-5 text-xl font-semibold text-white">You&apos;re on the free membership</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
            Upgrade to unlock member pricing, monthly store credit, faster points, and priority shipping.
          </p>
          <Link href="/membership" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-6 py-3 text-sm">View membership plans</Link>
        </section>
      ) : isLapsed ? (
        /* Paid plan on record, but no benefits are being applied. Say exactly
           that — never render live perk figures for an account not receiving
           them. */
        <section className="vl-panel rounded-2xl p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Plan on record</p>
              <h2 className="mt-1 text-2xl font-semibold text-white">{membership.tier.name}</h2>
              <p className="mt-1 text-sm capitalize text-zinc-400">{membership.billingCycle} billing</p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${statusPill.cls}`}>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
              {statusPill.text}
            </span>
          </div>

          <div className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-4">
            <p className="text-sm font-medium text-amber-100">{lapsedCopy.heading}</p>
            <p className="mt-1.5 text-sm leading-6 text-zinc-400">{lapsedCopy.body}</p>
          </div>

          <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Currently applied to your orders</p>
            <ul className="mt-2.5 space-y-1.5 text-sm text-zinc-400">
              <li>Member pricing — <span className="text-zinc-300">not applied</span></li>
              <li>Monthly store credit — <span className="text-zinc-300">not applied</span></li>
              <li>Points — <span className="text-zinc-300">{perks.pointsPerDollar}× per $1 (standard rate)</span></li>
            </ul>
          </div>

          {membership.status === "past_due" ? <MembershipBillingPanel membership={membership} /> : null}
          {membership.status === "paused" ? (
            <SubscriptionActions membership={{ status: membership.status, billingCycle: membership.billingCycle, cancelAtPeriodEnd: membership.cancelAtPeriodEnd }} />
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2.5">
            <Link href="/membership" className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">{lapsedCopy.cta}</Link>
          </div>
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
              // A cancellation/pause/resume is stored as "succeeded" with a $0
              // amount because the OPERATION worked — labelling it "Succeeded"
              // in green next to real charges reads as "you were billed".
              const paid = isPaidBillingEvent(event);
              const safeReason = customerSafeFailureReason(event.failureReason);
              const badge = failed
                ? { text: "Failed", cls: "text-rose-300" }
                : paid
                  ? { text: "Paid", cls: "text-emerald-300" }
                  : { text: "Completed", cls: "text-zinc-400" };
              return (
                <li key={event.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-zinc-200">{EVENT_LABELS[event.eventType] ?? event.eventType.replace(/_/g, " ")}</p>
                    <p className="text-xs text-zinc-500">
                      {formatDate(event.createdAt)}
                      {/* NEVER the stored failure_reason verbatim. It carries the
                          processor's raw JSON envelope (request_id, decline_code)
                          or our own internal wiring notes naming environment
                          variables — both were rendered straight into a
                          customer's billing history. */}
                      {failed && safeReason ? ` · ${safeReason}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    {event.amountCents > 0 ? <p className="font-medium text-white">{money(event.amountCents)}</p> : null}
                    <span className={`text-[11px] ${badge.cls}`}>{badge.text}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-5 text-zinc-500">
          Only charges marked <span className="text-emerald-300">Paid</span> took money from your account. Failed attempts never charge you, and plan changes are recorded here at $0.
        </p>
      </section>
    </div>
  );
}
