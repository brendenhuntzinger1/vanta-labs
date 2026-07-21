"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { PartnerProgramStats } from "@/lib/partner-portal";
import { SiteHeaderV2 } from "@/components/site-header-v2";

type SessionStatus = "loading" | "guest" | "customer" | "pending" | "approved" | "rejected" | "disabled";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">{label}</p>
      <p className="mt-2 text-2xl text-white sm:text-3xl">{value}</p>
    </div>
  );
}

export function PartnerProgramLanding({ initialStats }: { initialStats: PartnerProgramStats }) {
  const searchParams = useSearchParams();
  const [stats, setStats] = useState(initialStats);
  const [fullName, setFullName] = useState(() => searchParams.get("name") ?? "");
  const [loading, setLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");

  const [referralsPerMonth, setReferralsPerMonth] = useState(40);
  const [averageOrderValue, setAverageOrderValue] = useState(130);
  const [reorderRate, setReorderRate] = useState(35);
  const [commissionPercent, setCommissionPercent] = useState(15);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch("/api/partner/program-stats", { cache: "no-store" });
        const json = await response.json();
        if (response.ok && json.success) {
          setStats(json.stats as PartnerProgramStats);
        }
      } catch {
        // keep current stats on transient errors
      }
    }, 30000);

    return () => window.clearInterval(interval);
  }, []);

  // Detect who is viewing: a guest (must create/sign into a customer account
  // first), a plain customer (can apply), or an existing applicant/ambassador
  // (show their current status). Ambassadors are customers with an approved
  // partner profile — there is no separate ambassador login.
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session?.user) {
          if (active) setSessionStatus("guest");
          return;
        }

        const prefillName = typeof data.session.user.user_metadata?.full_name === "string"
          ? data.session.user.user_metadata.full_name
          : "";
        if (active && prefillName) {
          setFullName((current) => current || prefillName);
        }

        const meResponse = await fetch("/api/partner/me", { cache: "no-store" });
        if (meResponse.status === 401) {
          if (active) setSessionStatus("customer");
          return;
        }
        const meJson = await meResponse.json();
        const status = meJson?.partner?.status as string | undefined;

        if (!active) return;
        if (!status) {
          setSessionStatus("customer");
        } else if (status === "approved") {
          setSessionStatus("approved");
        } else if (status === "rejected") {
          setSessionStatus("rejected");
        } else if (status === "disabled") {
          setSessionStatus("disabled");
        } else {
          setSessionStatus("pending");
        }
      } catch {
        if (active) setSessionStatus("guest");
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const estimatedMonthlyCommission = useMemo(() => {
    const baseRevenue = referralsPerMonth * averageOrderValue;
    const reorderRevenue = baseRevenue * (reorderRate / 100);
    const totalRevenue = baseRevenue + reorderRevenue;
    return (commissionPercent / 100) * totalRevenue;
  }, [averageOrderValue, commissionPercent, referralsPerMonth, reorderRate]);

  const estimatedYearlyCommission = estimatedMonthlyCommission * 12;

  const handleApply = async () => {
    setLoading(true);
    setAuthMessage(null);

    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setSessionStatus("guest");
        throw new Error("Please sign in to your account first, then apply.");
      }

      // Ensure the httpOnly session cookie exists so /api/partner/apply can
      // authenticate the request.
      await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });

      const applyResponse = await fetch("/api/partner/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken, fullName: fullName.trim() }),
      });
      const applyJson = await applyResponse.json();
      if (!applyResponse.ok || !applyJson.success) {
        throw new Error(applyJson.error ?? "Unable to submit your application");
      }

      const status = String(applyJson.partner?.status ?? "pending");
      setSessionStatus(status === "approved" ? "approved" : "pending");
      setAuthMessage(
        status === "approved"
          ? "You're approved! Your Ambassador Stats tab is available in your account."
          : "Application received. It's under review — you'll get an email when a decision is made, and your Ambassador Stats tab will appear in your account once approved.",
      );
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Unable to submit your application");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <section className="relative mx-auto max-w-[1440px] px-4 sm:px-6 pb-12 pt-32 lg:px-12 lg:pt-40">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="vl2-eyebrow">Vanta Labs Partner Program</p>
            <h1 className="vl2-serif mt-4 text-4xl leading-[1.05] text-white sm:text-5xl lg:text-6xl">
              Earn recurring income with Vanta Labs.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/60 sm:text-lg">
              Join a high-performance affiliate network built for modern e-commerce growth. Share premium products, unlock recurring commissions, and manage performance with a real-time partner dashboard.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#apply" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">
                Become a Partner
              </a>
              <a href="#calculator" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">
                Estimate Earnings
              </a>
            </div>
          </div>

          <div className="vl2-glass p-6 sm:p-8">
            <h2 className="vl2-eyebrow">Program Stats</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <StatCard label="Total Commissions Paid" value={currency(stats.totalCommissionsPaid)} />
              <StatCard label="Average Partner Earnings" value={currency(stats.averagePartnerEarnings)} />
              <StatCard label="Average Approval Time" value={`${stats.averageApprovalTimeHours.toFixed(1)} hrs`} />
              <div className="sm:col-span-2">
                <StatCard label="Top Partner Payout" value={currency(stats.topPartnerPayout)} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="calculator" className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 lg:px-12">
        <div className="border border-white/10 p-5 sm:p-8">
          <h2 className="vl2-serif text-2xl text-white sm:text-3xl">Earnings Calculator</h2>
          <p className="mt-2 text-sm text-white/50">Model your potential monthly and yearly affiliate income in real time.</p>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-5">
              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60">
                  <span>Referrals per month</span>
                  <span>{referralsPerMonth}</span>
                </div>
                <input type="range" min={1} max={400} value={referralsPerMonth} onChange={(event) => setReferralsPerMonth(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60">
                  <span>Average order value</span>
                  <span>${averageOrderValue}</span>
                </div>
                <input type="range" min={40} max={500} value={averageOrderValue} onChange={(event) => setAverageOrderValue(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60">
                  <span>Customer reorder rate</span>
                  <span>{reorderRate}%</span>
                </div>
                <input type="range" min={0} max={100} value={reorderRate} onChange={(event) => setReorderRate(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-white/60">
                  <span>Commission percentage</span>
                  <span>{commissionPercent}%</span>
                </div>
                <input type="range" min={5} max={40} value={commissionPercent} onChange={(event) => setCommissionPercent(Number(event.target.value))} className="w-full" />
              </label>
            </div>

            <div className="border border-white/15 p-5">
              <p className="vl2-eyebrow">Projected Commissions</p>
              <p className="mt-3 break-words text-3xl text-white sm:text-4xl">{currency(estimatedMonthlyCommission)}</p>
              <p className="text-sm text-white/50">Estimated monthly</p>

              <div className="mt-6 border-t border-white/10 pt-5">
                <p className="text-3xl text-white">{currency(estimatedYearlyCommission)}</p>
                <p className="text-sm text-white/50">Estimated yearly</p>
              </div>

              <div className="mt-6 text-sm text-white/50">
                Commission rate used: <span className="text-white/75">{commissionPercent}%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1440px] gap-4 px-6 py-10 sm:grid-cols-2 lg:grid-cols-3 lg:px-12">
        {[
          "Lifetime recurring commissions",
          "Real-time performance dashboard",
          "Fast payouts and clear payout history",
          "Premium marketing assets",
          "Personal referral link + tracking",
          "Mobile-first partner command center",
        ].map((benefit) => (
          <div key={benefit} className="border border-white/10 p-5">
            <p className="text-sm text-white/75">{benefit}</p>
          </div>
        ))}
      </section>

      <section id="apply" className="mx-auto max-w-[1440px] px-4 sm:px-6 pb-20 pt-8 lg:px-12">
        <div className="border border-white/10 p-6 sm:p-8">
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <h3 className="vl2-serif text-2xl text-white">Become an Ambassador</h3>

              {sessionStatus === "loading" ? (
                <p className="mt-3 text-sm text-white/50">Checking your account…</p>
              ) : sessionStatus === "guest" ? (
                <>
                  <p className="mt-2 text-sm text-white/50">
                    The ambassador program is for Vanta Labs account holders. Sign in or create your free account, then come back here to apply — approval adds an <span className="text-white/80">Ambassador Stats</span> tab right inside your account.
                  </p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <a href="/account/login?next=/partner" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">Sign in / Create account</a>
                  </div>
                </>
              ) : sessionStatus === "approved" ? (
                <>
                  <p className="mt-2 text-sm text-white/50">You&apos;re an approved ambassador. Your live stats, referral link, and payouts live in your account.</p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <a href="/account/ambassador" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">Open Ambassador Stats</a>
                  </div>
                </>
              ) : sessionStatus === "pending" ? (
                <p className="mt-3 text-sm text-white/70">Your application is under review. We&apos;ll email you when a decision is made, and your Ambassador Stats tab will appear in your account once approved.</p>
              ) : sessionStatus === "rejected" || sessionStatus === "disabled" ? (
                <p className="mt-3 text-sm text-white/70">Your ambassador application isn&apos;t active right now. If you think this is a mistake, please reach out via the contact page.</p>
              ) : (
                <>
                  <p className="mt-2 text-sm text-white/50">You&apos;re signed in. Submit your application below — approved ambassadors get an Ambassador Stats tab in this same account.</p>
                  <label className="mt-5 block text-sm text-white/50">
                    <span className="mb-2 block">Full name</span>
                    <input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" required />
                  </label>
                  <button
                    type="button"
                    disabled={loading || !fullName.trim()}
                    onClick={handleApply}
                    className="vl2-btn-primary vl-focus-ring mt-6 px-6 py-3 text-sm disabled:opacity-60"
                  >
                    {loading ? "Submitting…" : "Submit Application"}
                  </button>
                </>
              )}

              {authMessage ? <p className="mt-4 text-sm text-white/75">{authMessage}</p> : null}
            </div>

            <div className="border border-white/10 p-5 text-sm text-white/60">
              <p className="vl2-eyebrow">Approval Process</p>
              <ol className="mt-4 space-y-3">
                <li>1. Sign in to your Vanta Labs account.</li>
                <li>2. Submit your ambassador application here.</li>
                <li>3. Admin reviews fit and audience quality.</li>
                <li>4. On approval, your Ambassador Stats tab unlocks in your account.</li>
              </ol>
              <p className="mt-4 text-white/40">Average approval time: {stats.averageApprovalTimeHours.toFixed(1)} hours.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
