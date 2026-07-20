"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { SiteHeaderV2 } from "@/components/site-header-v2";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function AmbassadorPage() {
  const router = useRouter();
  const [monthlyReferrals, setMonthlyReferrals] = useState(30);
  const [averageOrderValue, setAverageOrderValue] = useState(130);
  const [commissionRate, setCommissionRate] = useState(15);
  const [applicantName, setApplicantName] = useState("");
  const [applicantEmail, setApplicantEmail] = useState("");

  const monthlyProjection = useMemo(() => {
    return monthlyReferrals * averageOrderValue * (commissionRate / 100);
  }, [averageOrderValue, commissionRate, monthlyReferrals]);

  const yearlyProjection = monthlyProjection * 12;

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <main className="mx-auto max-w-[1440px] px-6 pb-20 pt-32 lg:px-12">
        <section className="border border-white/10 px-5 py-10 sm:px-8 sm:py-12">
          <div className="max-w-3xl">
            <p className="vl2-eyebrow">Vanta Ambassador Network</p>
            <h1 className="vl2-serif mt-3 text-4xl text-white sm:text-5xl">Grow with a premium biotech brand.</h1>
            <p className="mt-4 text-base leading-8 text-white/60 sm:text-lg">
              Join a curated partner program built for creators, researchers, and communities that value precision and transparency.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href="#apply" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">Apply as Ambassador</a>
              <Link href="/partner" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">Partner Dashboard</Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-6 text-[10px] uppercase tracking-[0.14em] text-white/40">
              <span>Fast Approval</span>
              <span>Reliable Payouts</span>
            </div>
          </div>
        </section>

        <section className="mt-7 grid gap-4 md:grid-cols-3">
          {[
            { title: "15% Base Commission", text: "Tiered rates available for high-volume ambassadors." },
            { title: "Recurring Revenue", text: "Earn from repeat customer orders tied to your referral stream." },
            { title: "Fast Approval", text: "Most qualified applications are reviewed in under 24 hours." },
          ].map((item) => (
            <article key={item.title} className="border border-white/10 p-5">
              <h2 className="text-lg text-white">{item.title}</h2>
              <p className="mt-2 text-sm leading-7 text-white/55">{item.text}</p>
            </article>
          ))}
        </section>

        <section className="mt-7 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]" id="calculator">
          <article className="border border-white/10 p-6 sm:p-7">
            <p className="vl2-eyebrow">Earnings Estimator</p>
            <h2 className="vl2-serif mt-3 text-2xl text-white">Estimate your potential</h2>
            <p className="mt-2 text-sm leading-7 text-white/55">Adjust these inputs to model your monthly and yearly ambassador income.</p>

            <div className="mt-6 space-y-5">
              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60"><span>Monthly referrals</span><span>{monthlyReferrals}</span></div>
                <input type="range" min={5} max={400} value={monthlyReferrals} onChange={(event) => setMonthlyReferrals(Number(event.target.value))} className="w-full" />
              </label>
              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60"><span>Average order value</span><span>${averageOrderValue}</span></div>
                <input type="range" min={40} max={500} value={averageOrderValue} onChange={(event) => setAverageOrderValue(Number(event.target.value))} className="w-full" />
              </label>
              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60"><span>Commission rate</span><span>{commissionRate}%</span></div>
                <input type="range" min={10} max={35} value={commissionRate} onChange={(event) => setCommissionRate(Number(event.target.value))} className="w-full" />
              </label>
            </div>
          </article>

          <aside className="vl2-glass p-6 sm:p-7">
            <p className="vl2-eyebrow">Projected Commission</p>
            <p className="mt-4 text-4xl text-white">{formatCurrency(monthlyProjection)}</p>
            <p className="text-sm text-white/50">Estimated monthly earnings</p>

            <div className="mt-6 border-t border-white/10 pt-5">
              <p className="text-3xl text-white">{formatCurrency(yearlyProjection)}</p>
              <p className="text-sm text-white/50">Estimated yearly earnings</p>
            </div>

            <div className="mt-6 border border-white/10 p-4 text-sm text-white/60">
              Final commissions depend on qualified conversions, approved orders, and payout terms.
            </div>
          </aside>
        </section>

        <section className="mt-7 grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <article className="border border-white/10 p-6 sm:p-7">
            <p className="vl2-eyebrow">Launch Timeline</p>
            <ol className="mt-5 space-y-4 text-sm">
              <li className="border border-white/10 p-4">
                <p className="text-white">1. Application Review</p>
                <p className="mt-1 text-white/55">Submit your profile, channels, and audience details for fit review.</p>
              </li>
              <li className="border border-white/10 p-4">
                <p className="text-white">2. Approval &amp; Setup</p>
                <p className="mt-1 text-white/55">Receive your referral assets, tracking links, and dashboard onboarding.</p>
              </li>
              <li className="border border-white/10 p-4">
                <p className="text-white">3. Scale &amp; Earn</p>
                <p className="mt-1 text-white/55">Publish campaigns, monitor conversion performance, and collect payouts.</p>
              </li>
            </ol>
          </article>

          <article id="apply" className="border border-white/10 p-6 sm:p-7">
            <p className="vl2-eyebrow">Application</p>
            <h2 className="vl2-serif mt-3 text-2xl text-white">Apply to Join</h2>
            <p className="mt-2 text-sm leading-7 text-white/55">
              Enter your name and email, then continue in the partner portal to create your account and submit your
              application — your details carry over automatically.
            </p>

            <form
              className="mt-5 grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const params = new URLSearchParams();
                if (applicantName.trim()) params.set("name", applicantName.trim());
                if (applicantEmail.trim()) params.set("email", applicantEmail.trim());
                const query = params.toString();
                router.push(`/partner${query ? `?${query}` : ""}#apply`);
              }}
            >
              <label className="text-sm text-white/60 sm:col-span-2">
                <span className="mb-2 block">Full name</span>
                <input
                  value={applicantName}
                  onChange={(event) => setApplicantName(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  placeholder="Your name"
                />
              </label>
              <label className="text-sm text-white/60">
                <span className="mb-2 block">Email</span>
                <input
                  type="email"
                  value={applicantEmail}
                  onChange={(event) => setApplicantEmail(event.target.value)}
                  className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
                  placeholder="you@domain.com"
                />
              </label>
              <label className="text-sm text-white/60">
                <span className="mb-2 block">Country</span>
                <input className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="United States" />
              </label>
              <label className="text-sm text-white/60 sm:col-span-2">
                <span className="mb-2 block">Primary platform</span>
                <input className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="Website, social handle, or newsletter" />
              </label>
              <label className="text-sm text-white/60 sm:col-span-2">
                <span className="mb-2 block">Audience overview</span>
                <textarea className="min-h-28 w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" placeholder="Tell us about your audience and traffic profile" />
              </label>
              <div className="sm:col-span-2">
                <button type="submit" className="vl2-btn-primary vl-focus-ring inline-flex px-6 py-3 text-sm">
                  Continue in Partner Portal
                </button>
              </div>
            </form>
          </article>
        </section>
      </main>
    </div>
  );
}
