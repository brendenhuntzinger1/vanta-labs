import Link from "next/link";
import { SiteHeader } from "@/components/site-header";

const ambassadorData = {
  name: "Mina Alvarez",
  referralCode: "VANTA10",
  referralLink: "https://vantalabs.demo/r/VANTA10",
  clicks: 184,
  orders: 22,
  conversionRate: "11.9%",
  referredRevenue: "$18,240",
  pendingCommission: "$1,459",
  approvedCommission: "$3,920",
  paidCommission: "$2,110",
};

const recentOrders = [
  { id: "ORD-1042", customer: "R. Ellis", amount: "$1,240", status: "Pending" },
  { id: "ORD-1088", customer: "J. Parker", amount: "$890", status: "Approved" },
  { id: "ORD-1101", customer: "C. Vale", amount: "$1,540", status: "Paid" },
];

export default function AmbassadorPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <SiteHeader />
      <main className="mx-auto max-w-7xl px-6 py-16 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-500">Ambassador dashboard</p>
          <h1 className="mt-3 text-4xl font-semibold text-white sm:text-5xl">Demo referral insights for ambassador partners.</h1>
          <p className="mt-6 text-lg leading-8 text-zinc-400">These metrics are sample data intended to demonstrate the experience once Supabase is connected.</p>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-8">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Ambassador profile</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">{ambassadorData.name}</h2>
            <div className="mt-6 space-y-3 text-sm text-zinc-300">
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <span>Referral code</span>
                <span className="text-white">{ambassadorData.referralCode}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <span>Referral link</span>
                <span className="text-white">{ambassadorData.referralLink}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <span>Clicks</span>
                <span className="text-white">{ambassadorData.clicks}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <span>Orders</span>
                <span className="text-white">{ambassadorData.orders}</span>
              </div>
              <div className="flex justify-between border-b border-zinc-800 pb-3">
                <span>Conversion rate</span>
                <span className="text-white">{ambassadorData.conversionRate}</span>
              </div>
            </div>
          </div>
          <div className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-8">
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Commission overview</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {[
                ["Referred revenue", ambassadorData.referredRevenue],
                ["Pending commission", ambassadorData.pendingCommission],
                ["Approved commission", ambassadorData.approvedCommission],
                ["Paid commission", ambassadorData.paidCommission],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[1.25rem] border border-zinc-800 bg-zinc-950/70 p-4">
                  <p className="text-sm text-zinc-500">{label}</p>
                  <p className="mt-2 text-xl font-semibold text-white">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-10 rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-8">
          <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Recent referral orders</p>
          <div className="mt-6 space-y-3">
            {recentOrders.map((order) => (
              <div key={order.id} className="flex flex-col gap-2 rounded-[1.25rem] border border-zinc-800 bg-zinc-950/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-white">{order.id}</p>
                  <p className="text-sm text-zinc-400">{order.customer}</p>
                </div>
                <div className="text-sm text-zinc-300">
                  <p>{order.amount}</p>
                  <p className="mt-1 text-zinc-500">{order.status}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
