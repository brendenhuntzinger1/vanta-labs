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
    { label: "Total Earnings", value: currency(liveSummary.totalEarnings) },
    { label: "Pending Commissions", value: currency(liveSummary.pendingCommissions) },
    { label: "Paid Commissions", value: currency(liveSummary.paidCommissions) },
    { label: "Total Orders", value: String(liveSummary.totalOrders) },
    { label: "Average Order Value", value: currency(liveSummary.averageOrderValue) },
    { label: "Returning Customer Rate", value: `${liveSummary.returningCustomerRate.toFixed(1)}%` },
    { label: "Clicks", value: String(liveSummary.totalClicks) },
    { label: "Conversion Rate", value: `${liveSummary.conversionRate.toFixed(2)}%` },
  ], [liveSummary]);

  return (
    <div className="space-y-6">
      <section className="vl-panel relative overflow-hidden rounded-[1.8rem] p-5 sm:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(103,232,249,0.12),transparent_50%)]" />
        <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Partner Command Center</p>
        <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Welcome back, {liveSummary.partnerName}</h1>
        <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">Performance updates are connected to your live referral orders and payment events in Supabase.</p>

        <div className="mt-5 rounded-2xl border border-cyan-400/20 bg-zinc-950/60 p-4">
          <p className="text-[11px] uppercase tracking-[0.25em] text-zinc-500">Your Referral Link</p>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 truncate text-sm text-cyan-200">{liveSummary.referralLink}</p>
            <button
              type="button"
              onClick={async () => {
                await copyText(liveSummary.referralLink);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
              className="vl-focus-ring rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/20"
            >
              {copied ? "Copied" : "Copy Link"}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Code: {liveSummary.referralCode} • Commission: {liveSummary.commissionPercent}%</p>
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
        <RevenueBars title="Monthly Revenue" points={liveSummary.monthlyRevenueSeries} colorClass="from-cyan-300 via-blue-300 to-indigo-300" />
        <RevenueBars title="Lifetime Revenue" points={liveSummary.lifetimeRevenueSeries} colorClass="from-emerald-300 via-cyan-300 to-blue-300" />
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
    </div>
  );
}
