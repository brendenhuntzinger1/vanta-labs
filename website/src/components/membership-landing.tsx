"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MembershipTier } from "@/lib/membership";
import { ScrollReveal } from "@/components/scroll-reveal";
import { TrustBadge } from "@/components/trust-badge";

type BillingCycle = "monthly" | "annual";

function money(cents: number) {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(2)}`;
}

const FAQ_ITEMS = [
  {
    q: "How do reward points work?",
    a: "Every paid order earns points based on your membership tier (2x, 3x, or 5x points per $1 spent on the merchandise total). 100 points equals $1 in store credit, redeemable at checkout on any future order.",
  },
  {
    q: "Do points expire?",
    a: "No. Points stay on your account until you redeem them, and redeeming stacks with your other checkout discounts.",
  },
  {
    q: "What happens if I get a refund?",
    a: "Points earned on a fully refunded order are automatically removed from your balance. Partial refunds don't affect points already earned.",
  },
  {
    q: "Can I cancel or change my plan?",
    a: "Yes, any time from your account settings — reach out and we'll take care of it while automated billing is being finished.",
  },
  {
    q: "Is billing live yet?",
    a: "Not yet — Research Plus and Elite Research membership activation is currently handled manually while we finish connecting a payment processor. Free membership (Research Member) is fully active today, including points on every order.",
  },
];

function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="space-y-3">
      {FAQ_ITEMS.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <div key={item.q} className="vl-panel-soft overflow-hidden rounded-2xl">
            <button
              type="button"
              onClick={() => setOpenIndex(isOpen ? null : index)}
              className="vl-focus-ring flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
              aria-expanded={isOpen}
            >
              <span className="text-sm font-medium text-zinc-100">{item.q}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 flex-shrink-0 text-zinc-400 transition-transform ${isOpen ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {isOpen ? <p className="px-5 pb-4 text-sm leading-6 text-zinc-400">{item.a}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

function RewardsCalculator({ tiers }: { tiers: MembershipTier[] }) {
  const [monthlySpend, setMonthlySpend] = useState(150);
  const [tierSlug, setTierSlug] = useState(tiers[0]?.slug ?? "free");

  const selectedTier = tiers.find((tier) => tier.slug === tierSlug) ?? tiers[0];
  const monthlyPoints = Math.floor(monthlySpend * (selectedTier?.pointsPerDollar ?? 2));
  const yearlyPoints = monthlyPoints * 12;
  const yearlyValue = (yearlyPoints / 100).toFixed(2);

  return (
    <div className="vl-panel rounded-[1.75rem] p-6 sm:p-8">
      <p className="vl-eyebrow text-[11px] text-cyan-300/80">Rewards Calculator</p>
      <h3 className="mt-2 text-2xl font-semibold text-white">See what you&apos;d earn</h3>

      <div className="mt-6 space-y-5">
        <label className="block text-sm text-zinc-300">
          Monthly spend: <span className="font-semibold text-white">${monthlySpend}</span>
          <input
            type="range"
            min={0}
            max={1000}
            step={10}
            value={monthlySpend}
            onChange={(event) => setMonthlySpend(Number(event.target.value))}
            className="mt-3 w-full accent-cyan-400"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {tiers.map((tier) => (
            <button
              key={tier.slug}
              type="button"
              onClick={() => setTierSlug(tier.slug)}
              className={tier.slug === tierSlug
                ? "rounded-full border border-cyan-300/50 bg-cyan-400/15 px-4 py-2 text-xs font-semibold text-cyan-100"
                : "rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs text-zinc-300 transition hover:border-white/30"}
            >
              {tier.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-white/10 pt-6">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Points / month</p>
          <p className="mt-1 text-2xl font-semibold text-white">{monthlyPoints.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Value / year</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-300">${yearlyValue}</p>
        </div>
      </div>
    </div>
  );
}

export function MembershipLanding({ tiers, isSignedInCustomer }: { tiers: MembershipTier[]; isSignedInCustomer: boolean }) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");

  const comparisonRows = useMemo(() => [
    { label: "Points per $1", getValue: (tier: MembershipTier) => `${tier.pointsPerDollar}x` },
    { label: "Free shipping", getValue: (tier: MembershipTier) => (tier.freeShipping ? "✓" : "—") },
    { label: "Priority shipping", getValue: (tier: MembershipTier) => (tier.priorityShipping ? "✓" : "—") },
    { label: "Early access", getValue: (tier: MembershipTier) => (tier.earlyAccess ? "✓" : "—") },
    { label: "Exclusive pricing", getValue: (tier: MembershipTier) => (tier.exclusivePricing ? "✓" : "—") },
    { label: "Referral bonus", getValue: (tier: MembershipTier) => `${tier.referralBonusPoints} pts` },
  ], []);

  return (
    <div className="px-4 pb-24 pt-14 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="text-center">
            <p className="vl-eyebrow text-[11px] text-cyan-300/80">Vanta Labs Membership</p>
            <h1 className="vl-display mt-4 text-4xl font-semibold text-white sm:text-5xl">Membership &amp; Rewards</h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-zinc-400 sm:text-base">
              Earn points on every order, unlock free and priority shipping, and get early access to new research
              compounds. Every registered customer starts earning automatically.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={80}>
          <div className="mt-8 flex justify-center gap-3">
            <TrustBadge icon="shield" label="No Hidden Fees" detail="Transparent pricing, always" />
            <TrustBadge icon="check" label="Automatic Tracking" detail="Points credit on every order" />
          </div>
        </ScrollReveal>

        <div className="mt-10 flex justify-center">
          <div className="vl-panel-soft inline-flex rounded-full p-1">
            <button
              type="button"
              onClick={() => setBillingCycle("monthly")}
              className={billingCycle === "monthly" ? "rounded-full bg-cyan-400/20 px-5 py-2 text-sm font-semibold text-cyan-100" : "rounded-full px-5 py-2 text-sm text-zinc-400"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle("annual")}
              className={billingCycle === "annual" ? "rounded-full bg-cyan-400/20 px-5 py-2 text-sm font-semibold text-cyan-100" : "rounded-full px-5 py-2 text-sm text-zinc-400"}
            >
              Annual <span className="text-emerald-300">(save ~17%)</span>
            </button>
          </div>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {tiers.map((tier, index) => {
            const price = billingCycle === "monthly" ? tier.monthlyPriceCents : tier.annualPriceCents;
            const isFeatured = tier.slug === "plus";
            return (
              <ScrollReveal key={tier.id} delayMs={index * 80}>
                <div
                  className={`vl-panel group relative flex h-full flex-col rounded-[1.75rem] p-6 transition duration-300 hover:-translate-y-1.5 hover:shadow-[0_20px_60px_-15px_rgba(103,232,249,0.35)] sm:p-8 ${isFeatured ? "border-cyan-300/40 ring-1 ring-cyan-300/30" : ""}`}
                >
                  {isFeatured ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-cyan-400 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-950">
                      Most Popular
                    </span>
                  ) : null}

                  <p className="vl-eyebrow text-[11px] text-zinc-500">{tier.name}</p>
                  <p className="mt-3 text-4xl font-semibold text-white">
                    {money(price)}
                    {price > 0 ? <span className="text-base font-normal text-zinc-500">/{billingCycle === "monthly" ? "mo" : "yr"}</span> : null}
                  </p>

                  <ul className="mt-6 flex-1 space-y-3 text-sm text-zinc-300">
                    {tier.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-start gap-2">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 flex-shrink-0 text-cyan-300">
                          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {benefit}
                      </li>
                    ))}
                  </ul>

                  {tier.slug === "free" ? (
                    <Link
                      href={isSignedInCustomer ? "/account" : "/account/login"}
                      className="vl-btn-primary vl-focus-ring mt-8 inline-flex items-center justify-center px-5 py-3 text-sm"
                    >
                      {isSignedInCustomer ? "View my rewards" : "Get Started Free"}
                    </Link>
                  ) : (
                    <div className="mt-8">
                      <Link
                        href="/contact"
                        className="vl-btn-secondary vl-focus-ring inline-flex w-full items-center justify-center px-5 py-3 text-sm"
                      >
                        Contact to upgrade
                      </Link>
                      <p className="mt-2 text-center text-[11px] text-zinc-500">Billing isn&apos;t connected yet — upgrades are activated manually.</p>
                    </div>
                  )}
                </div>
              </ScrollReveal>
            );
          })}
        </div>

        <ScrollReveal delayMs={100}>
          <div className="mt-16">
            <h2 className="text-center text-2xl font-semibold text-white">Compare plans</h2>
            <div className="vl-panel mt-6 overflow-x-auto rounded-2xl">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-zinc-400">
                    <th className="px-5 py-4 font-medium">Benefit</th>
                    {tiers.map((tier) => (
                      <th key={tier.id} className="px-5 py-4 text-center font-medium text-zinc-200">{tier.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((row) => (
                    <tr key={row.label} className="border-b border-white/5">
                      <td className="px-5 py-3 text-zinc-300">{row.label}</td>
                      {tiers.map((tier) => (
                        <td key={tier.id} className="px-5 py-3 text-center text-zinc-200">{row.getValue(tier)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={120}>
          <div className="mt-16">
            <RewardsCalculator tiers={tiers} />
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={140}>
          <div className="mt-16">
            <h2 className="text-center text-2xl font-semibold text-white">Frequently asked questions</h2>
            <div className="mx-auto mt-6 max-w-2xl">
              <FaqAccordion />
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
