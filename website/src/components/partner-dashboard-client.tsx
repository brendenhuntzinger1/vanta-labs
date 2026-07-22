"use client";

import { useEffect, useMemo, useState } from "react";
import { RevenueBars } from "@/components/revenue-bars";
import type { PartnerSummary } from "@/lib/partner-portal";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

export function PartnerDashboardClient({ summary }: { summary: PartnerSummary }) {
  const [liveSummary, setLiveSummary] = useState(summary);
  const [copied, setCopied] = useState(false);
  const [savingPayout, setSavingPayout] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState<string | null>(null);

  const updatePayoutMethod = async (method: "cash" | "store_credit") => {
    if (savingPayout || liveSummary.payoutMethod === method) return;
    setSavingPayout(true);
    setPayoutMessage(null);
    // Optimistic: reflect the choice immediately, revert on failure.
    setLiveSummary((prev) => ({ ...prev, payoutMethod: method }));
    try {
      const response = await fetch("/api/partner/payout-method", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to update");
      }
      setPayoutMessage("Saved");
    } catch {
      setLiveSummary((prev) => ({ ...prev, payoutMethod: method === "cash" ? "store_credit" : "cash" }));
      setPayoutMessage("Couldn't save — try again");
    } finally {
      setSavingPayout(false);
    }
  };

  useEffect(() => {
    let active = true;

    const loadLatest = async () => {
      try {
        const response = await fetch("/api/partner/summary", { cache: "no-store" });
        const json = await response.json();
        if (active && response.ok && json.success) {
          setLiveSummary(json.summary as PartnerSummary);
        }
      } catch {
        // Silent network retries; dashboard keeps last known state.
      }
    };

    const interval = window.setInterval(loadLatest, 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const topCards = useMemo(() => [
    { label: "Sales Generated", value: currency(liveSummary.totalRevenue) },
    { label: "Total Earnings", value: currency(liveSummary.totalEarnings) },
    { label: "Unpaid Balance", value: currency(liveSummary.pendingCommissions) },
    { label: "Paid Commissions", value: currency(liveSummary.paidCommissions) },
    { label: "Total Orders", value: String(liveSummary.totalOrders) },
    { label: "Average Order Value", value: currency(liveSummary.averageOrderValue) },
    { label: "Clicks", value: String(liveSummary.totalClicks) },
    { label: "Conversion Rate", value: `${liveSummary.conversionRate.toFixed(2)}%` },
    { label: "Returning Customer Rate", value: `${liveSummary.returningCustomerRate.toFixed(1)}%` },
  ], [liveSummary]);

  return (
    <div className="space-y-6">
      <section className="vl-panel relative overflow-hidden rounded-[1.8rem] p-5 sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.1),transparent_50%)]" />
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs uppercase tracking-[0.28em] text-zinc-300">Partner Command Center</p>
          <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
            {liveSummary.accountStatus === "approved" ? "Active" : liveSummary.accountStatus}
          </span>
        </div>
        <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Welcome back, {liveSummary.partnerName}</h1>
        <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">Performance updates are connected to your live referral orders and payment events in Supabase.</p>

        <div className="mt-5 rounded-2xl border border-white/20 bg-zinc-950/60 p-4">
          <p className="text-[11px] uppercase tracking-[0.25em] text-zinc-500">Your Referral Link</p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 truncate text-sm text-zinc-200">{liveSummary.referralLink}</p>
            <button
              type="button"
              onClick={async () => {
                await copyText(liveSummary.referralLink);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="vl-focus-ring rounded-full border border-white/30 bg-white/10 px-4 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-white/20"
            >
              {copied ? "Copied" : "Copy Link"}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Referral code: {liveSummary.referralCode} • Commission: {liveSummary.commissionPercent}%</p>
          <p className="mt-1 text-xs text-zinc-500">Coupon code (share for customers to use at checkout): <span className="font-semibold text-zinc-300">{liveSummary.referralCode}</span></p>
        </div>

        <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/[0.05] p-4">
          <p className="text-[11px] uppercase tracking-[0.25em] text-amber-300">Ambassador Requirements</p>
          <ul className="mt-3 space-y-2 text-sm text-zinc-300">
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-amber-300">•</span>
              <span><span className="font-semibold text-white">To stay active:</span> publish at least <span className="font-semibold text-white">{liveSummary.monthlyPostRequirement} promotional posts, videos, or advertisements per month</span> featuring Vanta Labs.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-0.5 text-amber-300">•</span>
              <span><span className="font-semibold text-white">Earn more:</span> consistently exceed the monthly minimum with quality content and your commission rate or bonuses can be negotiated. Reach out to discuss an upgrade.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {topCards.map((card) => (
          <div key={card.label} className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{card.label}</p>
            <p className="mt-2 text-2xl font-semibold text-white">{card.value}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <RevenueBars title="Monthly Revenue" points={liveSummary.monthlyRevenueSeries} colorClass="from-zinc-100 via-zinc-300 to-zinc-500" />
        <RevenueBars title="Lifetime Revenue" points={liveSummary.lifetimeRevenueSeries} colorClass="from-white via-zinc-200 to-zinc-500" />
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Recent Referrals & Orders</h2>
          <span className="text-xs text-zinc-500">Latest {liveSummary.recentOrders.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-2">Order</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Revenue</th>
                <th className="px-2 py-2">Commission</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {liveSummary.recentOrders.map((row) => (
                <tr key={row.orderId} className="border-t border-zinc-800/70 text-zinc-200">
                  <td className="px-2 py-2">{row.orderId.slice(0, 14)}...</td>
                  <td className="px-2 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
                  <td className="px-2 py-2">{row.customerEmail ?? "-"}</td>
                  <td className="px-2 py-2">{currency(row.amountPaid)}</td>
                  <td className="px-2 py-2">{currency(row.commissionAmount)}</td>
                  <td className="px-2 py-2">{row.commissionStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Payout History</h2>
          <span className="text-xs text-zinc-500">Paid every two weeks</span>
        </div>
        {liveSummary.payoutHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {liveSummary.payoutHistory.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-2">{currency(row.amount)}</td>
                    <td className="px-2 py-2">{row.note ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No payouts yet. Commissions are held for 14 days, then paid out on a biweekly basis.</p>
        )}
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Payout &amp; Store Credit</h2>
          <span className="text-sm text-zinc-300">Store credit balance: <span className="font-semibold text-emerald-300">{currency(liveSummary.walletBalanceCents / 100)}</span></span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Choose how you get paid. Store credit is worth <span className="font-semibold text-zinc-300">{liveSummary.storeCreditMultiplierPercent}%</span> of your cash commission and never expires — spend it at checkout on your own orders.</p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={savingPayout}
            onClick={() => updatePayoutMethod("cash")}
            className={`vl-focus-ring rounded-lg px-4 py-2 text-sm ${liveSummary.payoutMethod === "cash" ? "bg-cyan-300 font-semibold text-zinc-950" : "border border-zinc-700 text-zinc-200"}`}
          >
            Cash payout
          </button>
          <button
            type="button"
            disabled={savingPayout}
            onClick={() => updatePayoutMethod("store_credit")}
            className={`vl-focus-ring rounded-lg px-4 py-2 text-sm ${liveSummary.payoutMethod === "store_credit" ? "bg-cyan-300 font-semibold text-zinc-950" : "border border-zinc-700 text-zinc-200"}`}
          >
            Store credit ({liveSummary.storeCreditMultiplierPercent}%)
          </button>
          {payoutMessage ? <span className="self-center text-xs text-emerald-300">{payoutMessage}</span> : null}
        </div>

        {liveSummary.walletHistory.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="px-2 py-2">Date</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {liveSummary.walletHistory.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td className="px-2 py-2 capitalize">{row.reason.replace(/_/g, " ")}</td>
                    <td className={`px-2 py-2 ${row.amountCents < 0 ? "text-zinc-400" : "text-emerald-300"}`}>{row.amountCents < 0 ? "-" : "+"}{currency(Math.abs(row.amountCents) / 100)}</td>
                    <td className="px-2 py-2">{row.note ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">No store-credit activity yet.</p>
        )}
      </section>

      {liveSummary.marketingResources.length > 0 ? (
        <section className="vl-panel rounded-2xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Marketing Resources</h2>
          <p className="mt-1 text-xs text-zinc-500">Approved assets and links to help you promote — provided by the Vanta Labs team.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {liveSummary.marketingResources.map((resource) => (
              <a
                key={`${resource.title}-${resource.url}`}
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="vl-focus-ring rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4 transition hover:border-cyan-400/40"
              >
                <p className="text-sm font-semibold text-white">{resource.title}</p>
                {resource.description ? <p className="mt-1 text-xs text-zinc-400">{resource.description}</p> : null}
                <p className="mt-2 truncate text-xs text-cyan-300/80">{resource.url}</p>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
