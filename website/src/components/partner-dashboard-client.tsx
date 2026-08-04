"use client";

import { useEffect, useMemo, useState } from "react";
import { RevenueBars } from "@/components/revenue-bars";
import { ReferralCodeManager } from "@/components/referral-code-manager";
import { ReferralShare } from "@/components/referral-share";
import type { PartnerSummary } from "@/lib/partner-portal";
import { formatDisplayDate } from "@/lib/format-date";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

const PAYOUT_METHOD_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "paypal", label: "PayPal", hint: "PayPal email" },
  { value: "venmo", label: "Venmo", hint: "@username" },
  { value: "cashapp", label: "Cash App", hint: "$cashtag" },
];

function PayoutMethodEditor({ initialMethod, initialHandle }: { initialMethod: string | null; initialHandle: string | null }) {
  const [method, setMethod] = useState(initialMethod ?? "paypal");
  const [handle, setHandle] = useState(initialHandle ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isSet = Boolean(initialMethod && initialHandle);
  const hint = PAYOUT_METHOD_OPTIONS.find((o) => o.value === method)?.hint ?? "";

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/partner/payout-method", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, handle }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Could not save your payout method.");
      setMessage("Saved. We'll pay you here on the next cycle.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save your payout method.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`rounded-2xl border p-4 ${isSet ? "border-white/12 bg-white/[0.02]" : "border-emerald-400/40 bg-emerald-400/[0.06]"}`}>
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Payout method</p>
      {!isSet ? <p className="mt-1 text-xs text-emerald-200">Choose how you&apos;d like to get paid so we can send your commissions.</p> : null}
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="text-xs text-zinc-400">
          Platform
          <select value={method} onChange={(e) => setMethod(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 sm:w-40">
            {PAYOUT_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex-1 text-xs text-zinc-400">
          Your {PAYOUT_METHOD_OPTIONS.find((o) => o.value === method)?.label} handle
          <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={hint} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
        <button type="button" onClick={save} disabled={saving || !handle.trim()} className="vl2-btn-primary vl-focus-ring inline-flex px-4 py-2.5 text-xs disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-zinc-300">{message}</p> : null}
    </div>
  );
}

function StatCard({ label, value, sub, featured = false, accent }: { label: string; value: string; sub?: string; featured?: boolean; accent?: "gold" | "cyan" | "emerald" }) {
  const ring = accent === "gold" ? "border-amber-200/25 bg-gradient-to-br from-amber-200/[0.10] to-transparent"
    : accent === "cyan" ? "border-cyan-300/20 bg-gradient-to-br from-cyan-400/[0.10] to-transparent"
    : accent === "emerald" ? "border-emerald-400/20 bg-gradient-to-br from-emerald-400/[0.10] to-transparent"
    : "border-white/10 bg-white/[0.02]";
  return (
    <div className={`rounded-2xl border p-4 ${ring}`}>
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
      <p className={`mt-2 font-semibold text-white ${featured ? "text-2xl sm:text-3xl" : "text-xl"}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
    </div>
  );
}

const COMMISSION_STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-300/15 text-amber-200",
  approved_for_payout: "bg-cyan-400/15 text-cyan-200",
  commission_paid: "bg-emerald-400/15 text-emerald-300",
  paid: "bg-emerald-400/15 text-emerald-300",
  reversed: "bg-rose-400/15 text-rose-300",
  voided: "bg-zinc-500/15 text-zinc-400",
  manual_review: "bg-amber-300/15 text-amber-200",
};

function statusText(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function PartnerDashboardClient({ summary }: { summary: PartnerSummary }) {
  const [liveSummary, setLiveSummary] = useState(summary);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    const loadLatest = async () => {
      try {
        const response = await fetch("/api/partner/summary", { cache: "no-store" });
        const json = await response.json();
        if (active && response.ok && json.success) setLiveSummary(json.summary as PartnerSummary);
      } catch {
        /* keep last known state */
      }
    };
    const interval = window.setInterval(loadLatest, 20000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const statusOptions = useMemo(() => {
    const set = new Set(liveSummary.recentOrders.map((o) => o.commissionStatus));
    return ["all", ...Array.from(set)];
  }, [liveSummary.recentOrders]);

  const filteredCommissions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return liveSummary.recentOrders.filter((o) => {
      const matchesStatus = statusFilter === "all" || o.commissionStatus === statusFilter;
      const matchesQuery = !q || o.orderId.toLowerCase().includes(q) || (o.customerEmail ?? "").toLowerCase().includes(q);
      return matchesStatus && matchesQuery;
    });
  }, [liveSummary.recentOrders, statusFilter, query]);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <section className="vl-fade-up vl-panel relative overflow-hidden rounded-2xl p-5 sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(242,201,76,0.10),transparent_55%)]" />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Ambassador Portal</p>
            <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-200">
              {liveSummary.accountStatus === "approved" ? "Active" : liveSummary.accountStatus}
            </span>
          </div>
          <h1 className="vl2-serif mt-2 text-3xl text-white sm:text-4xl">Welcome back, {liveSummary.partnerName}.</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {liveSummary.commissionPercent}% commission · you also get <span className="text-emerald-300">15% off your own orders</span> while approved.
          </p>
        </div>
      </section>

      {/* Earnings — featured */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total earnings" value={currency(liveSummary.totalEarnings)} featured accent="gold" sub="lifetime" />
        <StatCard label="Pending" value={currency(liveSummary.pendingOnlyCommissions)} sub="14-day hold" />
        <StatCard label="Next payout" value={currency(liveSummary.approvedCommissions)} accent="cyan" sub="approved · every 2 weeks" />
        <StatCard label="Paid out" value={currency(liveSummary.paidCommissions)} accent="emerald" sub="all time" />
      </section>

      {/* Secondary metrics */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="This month" value={currency(liveSummary.monthlyCommissions)} />
        <StatCard label="Sales generated" value={currency(liveSummary.totalRevenue)} />
        <StatCard label="Orders" value={String(liveSummary.totalOrders)} />
        <StatCard label="Avg order" value={currency(liveSummary.averageOrderValue)} />
        <StatCard label="Clicks" value={String(liveSummary.totalClicks)} />
        <StatCard label="Conversion" value={`${liveSummary.conversionRate.toFixed(1)}%`} />
      </section>

      {/* Referral tools */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Your referral link</h2>
        <p className="mt-1 text-sm text-zinc-400">Share your link or code — customers get a discount, you earn commission.</p>
        <div className="mt-4">
          <ReferralCodeManager initialCode={liveSummary.referralCode} referralLink={liveSummary.referralLink} />
        </div>
        <div className="mt-5 border-t border-white/10 pt-5">
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Share to</p>
          <div className="mt-3">
            <ReferralShare referralLink={liveSummary.referralLink} code={liveSummary.referralCode} />
          </div>
        </div>
        <div className="mt-5 border-t border-white/10 pt-5">
          <PayoutMethodEditor initialMethod={liveSummary.payoutMethod} initialHandle={liveSummary.payoutHandle} />
        </div>
      </section>

      {/* Performance graphs */}
      <section className="grid gap-4 lg:grid-cols-2">
        <RevenueBars title="Monthly Revenue" points={liveSummary.monthlyRevenueSeries} colorClass="from-cyan-200 via-cyan-300 to-cyan-500" />
        <RevenueBars title="Lifetime Revenue" points={liveSummary.lifetimeRevenueSeries} colorClass="from-amber-100 via-amber-200 to-amber-400" />
      </section>

      {/* Commission history + filters */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Commission history</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search order or customer"
              aria-label="Search commissions"
              className="vl-input w-full px-3 py-2 text-sm sm:w-56"
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status" className="vl-input px-3 py-2 text-sm">
              {statusOptions.map((s) => <option key={s} value={s}>{s === "all" ? "All statuses" : statusText(s)}</option>)}
            </select>
          </div>
        </div>

        {filteredCommissions.length === 0 ? (
          <p className="mt-6 text-sm text-zinc-500">
            {liveSummary.recentOrders.length === 0 ? "No commissions yet — share your link to start earning." : "No commissions match your filters."}
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                  <th className="px-2 py-2 font-medium">Order</th>
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Customer</th>
                  <th className="px-2 py-2 text-right font-medium">Revenue</th>
                  <th className="px-2 py-2 text-right font-medium">Commission</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredCommissions.map((row) => (
                  <tr key={row.orderId} className="border-t border-white/[0.06] text-zinc-200">
                    <td className="px-2 py-2.5 font-mono text-xs">{row.orderId.slice(0, 12)}…</td>
                    <td className="px-2 py-2.5 text-zinc-400">{formatDisplayDate(row.createdAt, "medium")}</td>
                    <td className="px-2 py-2.5 text-zinc-400">{row.customerEmail ?? "—"}</td>
                    <td className="px-2 py-2.5 text-right">{currency(row.amountPaid)}</td>
                    <td className="px-2 py-2.5 text-right font-medium text-white">{currency(row.commissionAmount)}</td>
                    <td className="px-2 py-2.5">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] ${COMMISSION_STATUS_STYLE[row.commissionStatus] ?? "bg-white/8 text-zinc-300"}`}>
                        {statusText(row.commissionStatus)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Payout history */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Payout history</h2>
          <span className="text-xs text-zinc-500">Paid every two weeks</span>
        </div>
        {liveSummary.payoutHistory.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-zinc-500">
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 text-right font-medium">Amount</th>
                  <th className="px-2 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {liveSummary.payoutHistory.map((row) => (
                  <tr key={row.id} className="border-t border-white/[0.06] text-zinc-200">
                    <td className="px-2 py-2.5 text-zinc-400">{formatDisplayDate(row.createdAt, "medium")}</td>
                    <td className="px-2 py-2.5 text-right font-medium text-white">{currency(row.amount)}</td>
                    <td className="px-2 py-2.5 text-zinc-400">{row.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">No payouts yet. Commissions are held for 14 days, then paid on a biweekly basis.</p>
        )}
      </section>

      {/* Requirements */}
      <section className="vl-panel rounded-2xl border-amber-400/20 p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">Staying active &amp; earning more</p>
        <ul className="mt-3 space-y-2 text-sm text-zinc-300">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-amber-300">•</span>
            <span><span className="font-semibold text-white">To stay active:</span> share Vanta Labs in at least <span className="font-semibold text-white">3 social posts per month</span>.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-amber-300">•</span>
            <span><span className="font-semibold text-white">Earn more:</span> consistently post <span className="font-semibold text-white">5+ quality videos per month</span> and your commission rate or bonuses can be negotiated — reach out to discuss an upgrade.</span>
          </li>
        </ul>
      </section>

      {/* Marketing resources */}
      {liveSummary.marketingResources.length > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Marketing resources</h2>
          <p className="mt-1 text-xs text-zinc-500">Approved assets and links to help you promote — from the Vanta Labs team.</p>
          <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {liveSummary.marketingResources.map((resource) => (
              <a key={`${resource.title}-${resource.url}`} href={resource.url} target="_blank" rel="noreferrer" className="vl-focus-ring rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors duration-200 hover:border-cyan-400/40">
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
