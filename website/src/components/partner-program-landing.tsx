"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { PartnerProgramStats } from "@/lib/partner-portal";
import { SiteHeaderV2 } from "@/components/site-header-v2";

type AuthMode = "signup" | "login";

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

function getEmailRedirectUrl() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (siteUrl) {
    return `${siteUrl.replace(/\/+$/, "")}/partner`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}/partner`;
  }

  return undefined;
}

export function PartnerProgramLanding({ initialStats }: { initialStats: PartnerProgramStats }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [stats, setStats] = useState(initialStats);
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState(() => searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState(() => searchParams.get("name") ?? "");
  const [loading, setLoading] = useState(false);
  const [completingVerification, setCompletingVerification] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

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

  useEffect(() => {
    let active = true;

    const completePartnerSignup = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const accessToken = data.session?.access_token;
        const user = data.session?.user;

        if (!accessToken || !user) {
          return;
        }

        const role = String(user.app_metadata?.role ?? user.user_metadata?.role ?? "").toLowerCase();
        if (role !== "partner") {
          return;
        }

        if (active) {
          setCompletingVerification(true);
        }

        const fallbackName = typeof user.user_metadata?.full_name === "string"
          ? user.user_metadata.full_name
          : (user.email ?? "Partner").split("@")[0];

        const applyResponse = await fetch("/api/partner/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken,
            fullName: String(fallbackName || "Partner").trim(),
          }),
        });
        const applyJson = await applyResponse.json();
        if (!applyResponse.ok || !applyJson.success) {
          throw new Error(applyJson.error ?? "Unable to complete partner application");
        }

        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken }),
        });

        const status = String(applyJson.partner?.status ?? "pending");
        if (status === "approved") {
          router.push("/partner/dashboard");
        } else {
          router.push("/partner/pending");
        }
        router.refresh();
      } catch (error) {
        if (active) {
          setAuthMessage(error instanceof Error ? error.message : "Unable to complete email verification");
        }
      } finally {
        if (active) {
          setCompletingVerification(false);
        }
      }
    };

    void completePartnerSignup();

    return () => {
      active = false;
    };
  }, [router]);

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
          emailRedirectTo: getEmailRedirectUrl(),
        },
      });

      if (error || !data.user) {
        throw new Error(error?.message ?? "Unable to create account");
      }

      if (!data.session?.access_token) {
        setAuthMessage("Thank you. Your ambassador application was received and is pending approval. We will be getting back to you soon.");
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
    <div className="min-h-screen overflow-x-hidden bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />

      <section className="relative mx-auto max-w-[1440px] px-6 pb-12 pt-32 lg:px-12 lg:pt-40">
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

      <section id="calculator" className="mx-auto max-w-[1440px] px-6 py-10 lg:px-12">
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
              <p className="mt-3 text-4xl text-white">{currency(estimatedMonthlyCommission)}</p>
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

      <section id="apply" className="mx-auto max-w-[1440px] px-6 pb-20 pt-8 lg:px-12">
        <div className="border border-white/10 p-6 sm:p-8">
          <div className="mb-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => setAuthMode("signup")} className={authMode === "signup" ? "border border-white bg-white/10 px-4 py-2 text-sm text-white" : "border border-white/15 px-4 py-2 text-sm text-white/45"}>Become a Partner</button>
            <button type="button" onClick={() => setAuthMode("login")} className={authMode === "login" ? "border border-white bg-white/10 px-4 py-2 text-sm text-white" : "border border-white/15 px-4 py-2 text-sm text-white/45"}>Partner Login</button>
          </div>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <h3 className="vl2-serif text-2xl text-white">{authMode === "signup" ? "Apply in Minutes" : "Welcome Back"}</h3>
              <p className="mt-2 text-sm text-white/50">
                {authMode === "signup"
                  ? "Create your account and submit your partner application. Approved partners unlock full dashboard access."
                  : "Sign in to access your dashboard. Pending applications will be directed to the approval status page."}
              </p>

              {authMode === "signup" ? (
                <label className="mt-5 block text-sm text-white/50">
                  <span className="mb-2 block">Full name</span>
                  <input value={fullName} onChange={(event) => setFullName(event.target.value)} className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" required />
                </label>
              ) : null}

              <label className="mt-4 block text-sm text-white/50">
                <span className="mb-2 block">Email</span>
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" required />
              </label>

              <label className="mt-4 block text-sm text-white/50">
                <span className="mb-2 block">Password</span>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full border border-white/15 bg-black/40 px-4 py-3 text-white placeholder:text-white/30 outline-none transition focus:border-white/50" required />
              </label>

              <button
                type="button"
                disabled={loading || completingVerification}
                onClick={authMode === "signup" ? handleSignup : handleLogin}
                className="vl2-btn-primary vl-focus-ring mt-6 px-6 py-3 text-sm disabled:opacity-60"
              >
                {(loading || completingVerification) ? "Processing..." : authMode === "signup" ? "Submit Partner Application" : "Sign In"}
              </button>

              {authMessage ? <p className="mt-4 text-sm text-white/75">{authMessage}</p> : null}
            </div>

            <div className="border border-white/10 p-5 text-sm text-white/60">
              <p className="vl2-eyebrow">Approval Process</p>
              <ol className="mt-4 space-y-3">
                <li>1. Create account and submit your application.</li>
                <li>2. Admin reviews fit and audience quality.</li>
                <li>3. Upon approval, your dashboard unlocks instantly.</li>
              </ol>
              <p className="mt-4 text-white/40">Average approval time: {stats.averageApprovalTimeHours.toFixed(1)} hours.</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
