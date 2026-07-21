import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getPayoutDashboard } from "@/lib/admin-payouts";
import { AdminPayoutsClient } from "@/components/admin-payouts-client";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? "border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)]" : "border-white/10 bg-white/[0.02]"}`}>
      <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-400">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${accent ? "text-[color:var(--accent-gold)]" : "text-white"}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-zinc-500">{sub}</p> : null}
    </div>
  );
}

export default async function AdminPayoutsPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) redirect("/vault");

  const { summary, rows } = await getPayoutDashboard().catch(() => ({
    summary: {
      orders: 0,
      totalGross: 0,
      totalNetRevenue: 0,
      total3plOwed: 0,
      totalProfit: 0,
      pendingPayoutTotal: 0,
      paidPayoutTotal: 0,
      payoutModel: "percent",
      payoutRate: 0,
    },
    rows: [],
  }));
  const modelLabel = summary.payoutModel === "percent"
    ? `${summary.payoutRate}% of order total`
    : `${money(summary.payoutRate)} per vial/unit`;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold sm:text-3xl">3PL Payouts</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Payout model: <span className="text-zinc-200">{modelLabel}</span> · change it in{" "}
              <Link href="/admin/settings" className="text-cyan-300 hover:underline">Settings</Link>.
            </p>
          </div>
          <Link href="/api/admin/payouts/export" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">Export report CSV</Link>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Gross Revenue" value={money(summary.totalGross)} sub={`${summary.orders} paid orders`} />
          <StatCard label="Net Revenue" value={money(summary.totalNetRevenue)} sub="After processor fees" />
          <StatCard label="Owed to 3PL" value={money(summary.total3plOwed)} sub={`${money(summary.pendingPayoutTotal)} pending`} accent />
          <StatCard label="Business Profit" value={money(summary.totalProfit)} sub="Net revenue − 3PL owed" />
        </div>

        <AdminPayoutsClient rows={rows} />
      </div>
    </div>
  );
}
