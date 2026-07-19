"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { PartnerProgramStats } from "@/lib/partner-portal";

type AuthMode = "signup" | "login";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="vl-panel rounded-2xl p-4 backdrop-blur-xl">
      <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white sm:text-3xl">{value}</p>
    </div>
  );
}

export function PartnerProgramLanding({ initialStats }: { initialStats: PartnerProgramStats }) {
  const router = useRouter();
  const [stats, setStats] = useState(initialStats);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const [referralsPerMonth, setReferralsPerMonth] = useState(40);
  const [averageOrderValue, setAverageOrderValue] = useState(130);
  const [reorderRate, setReorderRate] = useState(35);
  const [commissionPercent, setCommissionPercent] = useState(20);

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

  const estimatedMonthlyCommission = useMemo(() => {
    const baseRevenue = referralsPerMonth * averageOrderValue;
    const reorderRevenue = baseRevenue * (reorderRate / 100);
    const totalRevenue = baseRevenue + reorderRevenue;
    return (commissionPercent / 100) * totalRevenue;
  }, [averageOrderValue, commissionPercent, referralsPerMonth, reorderRate]);

  const estimatedYearlyCommission = estimatedMonthlyCommission * 12;

  const handleSignup = async () => {
    setLoading(true);
    setAuthMessage(null);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: fullName.trim(), role: "partner" },
        },
      });

      if (error || !data.user) {
        throw new Error(error?.message ?? "Unable to create account");
      }

      if (!data.session?.access_token) {
        setAuthMessage("Account created. Please verify your email, then sign in to complete your application.");
        return;
      }

      const applyResponse = await fetch("/api/partner/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: data.session.access_token,
          fullName: fullName.trim(),
        }),
      });

      const applyJson = await applyResponse.json();
      if (!applyResponse.ok || !applyJson.success) {
        throw new Error(applyJson.error ?? "Unable to submit partner application");
      }

      await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: data.session.access_token }),
      });

      router.push("/partner/pending");
      router.refresh();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Unable to complete signup");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    setLoading(true);
    setAuthMessage(null);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error || !data.session?.access_token) {
        throw new Error(error?.message ?? "Unable to sign in");
      }

      const sessionResponse = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: data.session.access_token }),
      });
      const sessionJson = await sessionResponse.json();
      if (!sessionResponse.ok || !sessionJson.success) {
        throw new Error(sessionJson.error ?? "Unable to establish session");
      }

      const meResponse = await fetch("/api/partner/me", { cache: "no-store" });
      const meJson = await meResponse.json();
      const status = meJson?.partner?.status;

      if (status === "approved") {
        router.push("/partner/dashboard");
      } else {
        router.push("/partner/pending");
      }
      router.refresh();
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="vl-page-shell min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(34,211,238,0.14),transparent_35%),radial-gradient(circle_at_85%_18%,rgba(99,102,241,0.15),transparent_30%),linear-gradient(150deg,#04060e_0%,#0b1324_45%,#060912_100%)] text-zinc-100">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-[10%] top-[16%] h-2 w-2 rounded-full bg-cyan-300/35 animate-pulse" />
        <div className="absolute right-[14%] top-[28%] h-3 w-3 rounded-full bg-blue-300/25 animate-pulse" />
        <div className="absolute left-[25%] bottom-[24%] h-2 w-2 rounded-full bg-indigo-300/25 animate-pulse" />
        <div className="absolute right-[22%] bottom-[18%] h-2 w-2 rounded-full bg-cyan-200/30 animate-pulse" />
      </div>

      <section className="relative mx-auto max-w-7xl px-4 pb-12 pt-20 sm:px-6 lg:px-8 lg:pt-28">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="text-xs uppercase tracking-[0.34em] text-cyan-300/85">Vanta Labs Partner Program</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight text-white sm:text-5xl lg:text-6xl">
              Earn Recurring Income with Vanta Labs.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-300 sm:text-lg">
              Join a high-performance affiliate network built for modern e-commerce growth. Share premium products, unlock recurring commissions, and manage performance with a real-time partner dashboard.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#apply" className="vl-focus-ring rounded-full bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:brightness-105">
                Become a Partner
              </a>
              <a href="#calculator" className="vl-btn-secondary rounded-full px-6 py-3 text-sm">
                Estimate Earnings
              </a>
            </div>
          </div>

          <div className="vl-panel relative overflow-hidden rounded-[2rem] p-6 sm:p-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.18),transparent_55%)]" />
            <h2 className="relative text-sm font-semibold uppercase tracking-[0.26em] text-zinc-300">Program Stats</h2>
            <div className="relative mt-4 grid gap-3 sm:grid-cols-2">
              <StatCard label="Total Commissions Paid" value={currency(stats.totalCommissionsPaid)} />
              <StatCard label="Average Partner Earnings" value={currency(stats.averagePartnerEarnings)} />
              <StatCard label="Average Approval Time" value={`${stats.averageApprovalTimeHours.toFixed(1)} hrs`} />
              <StatCard label="Lifetime Commissions" value={currency(stats.lifetimeCommissions)} />
              <div className="sm:col-span-2">
                <StatCard label="Top Partner Payout" value={currency(stats.topPartnerPayout)} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="calculator" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="vl-panel rounded-[2rem] p-5 sm:p-8">
          <h2 className="text-2xl font-semibold text-white sm:text-3xl">Earnings Calculator</h2>
          <p className="mt-2 text-sm text-zinc-400">Model your potential monthly and yearly affiliate income in real time.</p>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="space-y-5">
              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-zinc-300">
                  <span>Referrals per month</span>
                  <span>{referralsPerMonth}</span>
                </div>
                <input type="range" min={1} max={400} value={referralsPerMonth} onChange={(event) => setReferralsPerMonth(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-zinc-300">
                  <span>Average order value</span>
                  <span>${averageOrderValue}</span>
                </div>
                <input type="range" min={40} max={500} value={averageOrderValue} onChange={(event) => setAverageOrderValue(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-zinc-300">
                  <span>Customer reorder rate</span>
                  <span>{reorderRate}%</span>
                </div>
                <input type="range" min={0} max={100} value={reorderRate} onChange={(event) => setReorderRate(Number(event.target.value))} className="w-full" />
              </label>

              <label className="block">
                <div className="mb-2 flex justify-between text-sm text-zinc-300">
                  <span>Commission percentage</span>
                  <span>{commissionPercent}%</span>
                </div>
                <input type="range" min={5} max={40} value={commissionPercent} onChange={(event) => setCommissionPercent(Number(event.target.value))} className="w-full" />
              </label>
            </div>

            <div className="rounded-2xl border border-cyan-300/20 bg-zinc-950/60 p-5">
              <p className="text-xs uppercase tracking-[0.26em] text-zinc-500">Projected Commissions</p>
              <p className="mt-3 text-4xl font-semibold text-cyan-200">{currency(estimatedMonthlyCommission)}</p>
              <p className="text-sm text-zinc-400">Estimated monthly</p>

              <div className="mt-6 border-t border-zinc-800 pt-5">
                <p className="text-3xl font-semibold text-white">{currency(estimatedYearlyCommission)}</p>
                <p className="text-sm text-zinc-400">Estimated yearly</p>
              </div>

              <div className="mt-6 text-sm text-zinc-400">
                Commission rate used: <span className="text-zinc-200">{commissionPercent}%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8">
        {[
          "Lifetime recurring commissions",
          "Real-time performance dashboard",
          "Fast payouts and clear payout history",
          "Premium marketing assets",
          "Personal referral link + tracking",
          "Mobile-first partner command center",
        ].map((benefit) => (
          <div key={benefit} className="vl-panel rounded-2xl p-5">
            <p className="text-sm text-zinc-200">{benefit}</p>
          </div>
        ))}
      </section>

      <section id="apply" className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        <div className="vl-panel rounded-[2rem] p-6 sm:p-8">
          <div className="mb-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => setAuthMode("signup")} className={authMode === "signup" ? "rounded-full border border-cyan-300/50 bg-cyan-300/15 px-4 py-2 text-sm text-cyan-100" : "rounded-full border border-white/15 px-4 py-2 text-sm text-zinc-400"}>Become a Partner</button>
            <button type="button" onClick={() => setAuthMode("login")} className={authMode === "login" ? "rounded-full border border-cyan-300/50 bg-cyan-300/15 px-4 py-2 text-sm text-cyan-100" : "rounded-full border border-white/15 px-4 py-2 text-sm text-zinc-400"}>Partner Login</button>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <h3 className="text-2xl font-semibold text-white">{authMode === "signup" ? "Apply in Minutes" : "Welcome Back"}</h3>
              <p className="mt-2 text-sm text-zinc-400">
                {authMode === "signup"
                  ? "Create your account and submit your partner application. Approved partners unlock full dashboard access."
                  : "Sign in to access your dashboard. Pending applications will be directed to the approval status page."}
              </p>

              {authMode === "signup" ? (
                <label className="mt-5 block text-sm text-zinc-400">
                  <span className="mb-2 block">Full name</span>
                  <input value={fullName} onChange={(event) => setFullName(event.target.value)} className="vl-input w-full px-4 py-3" required />
                </label>
              ) : null}

              <label className="mt-4 block text-sm text-zinc-400">
                <span className="mb-2 block">Email</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="vl-input w-full px-4 py-3" required />
              </label>

              <label className="mt-4 block text-sm text-zinc-400">
                <span className="mb-2 block">Password</span>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="vl-input w-full px-4 py-3" required />
              </label>

              <button
                type="button"
                disabled={loading}
                onClick={authMode === "signup" ? handleSignup : handleLogin}
                className="vl-focus-ring mt-6 rounded-full bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-6 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-60"
              >
                {loading ? "Processing..." : authMode === "signup" ? "Submit Partner Application" : "Sign In"}
              </button>

              {authMessage ? <p className="mt-4 text-sm text-cyan-200">{authMessage}</p> : null}
            </div>

            <div className="rounded-2xl border border-white/12 bg-zinc-950/60 p-5 text-sm text-zinc-300">
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Approval Process</p>
              <ol className="mt-4 space-y-3">
                <li>1. Create account and submit your application.</li>
                <li>2. Admin reviews fit and audience quality.</li>
                <li>3. Upon approval, your dashboard unlocks instantly.</li>
              </ol>
              <p className="mt-4 text-zinc-500">Average approval time: {stats.averageApprovalTimeHours.toFixed(1)} hours.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
