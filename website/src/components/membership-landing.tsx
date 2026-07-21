"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MembershipTier } from "@/lib/membership";
import { ScrollReveal } from "@/components/scroll-reveal";

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
    a: "Yes, any time from your account dashboard — cancel before your next renewal date and you'll keep access through the period you already paid for.",
  },
  {
    q: "Is billing live yet?",
    a: "The membership signup flow, billing schedule, and dashboard are fully built and active — a payment processor isn't connected yet, so a card can't be charged until that's finished. Signing up saves your membership request, and billing begins automatically the moment a processor is connected. Free membership (Research Member) is fully active today, including points on every order.",
  },
];

function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="space-y-3">
      {FAQ_ITEMS.map((item, index) => {
        const isOpen = openIndex === index;
        return (
          <div key={item.q} className="border border-white/10 bg-black/30">
            <button
              type="button"
              onClick={() => setOpenIndex(isOpen ? null : index)}
              className="vl-focus-ring flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
              aria-expanded={isOpen}
            >
              <span className="text-sm text-white">{item.q}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 flex-shrink-0 text-white/40 transition-transform ${isOpen ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {isOpen ? <p className="px-5 pb-4 text-sm leading-6 text-white/55">{item.a}</p> : null}
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
    <div className="vl2-glass p-6 sm:p-8">
      <p className="vl2-eyebrow">Rewards Calculator</p>
      <h3 className="vl2-serif mt-2 text-2xl text-white">See what you&apos;d earn</h3>

      <div className="mt-6 space-y-5">
        <label className="block text-sm text-white/60">
          Monthly spend: <span className="text-white">${monthlySpend}</span>
          <input
            type="range"
            min={0}
            max={1000}
            step={10}
            value={monthlySpend}
            onChange={(event) => setMonthlySpend(Number(event.target.value))}
            className="mt-3 w-full accent-white"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          {tiers.map((tier) => (
            <button
              key={tier.slug}
              type="button"
              onClick={() => setTierSlug(tier.slug)}
              className={tier.slug === tierSlug
                ? "border border-white bg-white/10 px-4 py-2 text-xs text-white"
                : "border border-white/15 px-4 py-2 text-xs text-white/55 transition hover:border-white/35 hover:text-white"}
            >
              {tier.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 border-t border-white/10 pt-6">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Points / month</p>
          <p className="mt-1 text-2xl text-white">{monthlyPoints.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-white/40">Value / year</p>
          <p className="mt-1 text-2xl text-emerald-300">${yearlyValue}</p>
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
    <div className="relative z-10 px-6 pb-24 pt-32 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="text-center">
            <p className="vl2-eyebrow">Vanta Labs Membership</p>
            <h1 className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Membership &amp; Rewards</h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/60 sm:text-base">
              Earn points on every order, unlock free and priority shipping, and get early access to new research
              compounds. Every registered customer starts earning automatically.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={80}>
          <div className="mt-8 flex justify-center gap-8 text-[10px] uppercase tracking-[0.14em] text-white/45">
            <span>No Hidden Fees</span>
            <span>Automatic Tracking</span>
          </div>
        </ScrollReveal>

        {tiers.length === 0 ? (
          <ScrollReveal delayMs={80}>
            <div className="mt-12 border border-white/10 bg-white/[0.02] p-10 text-center">
              <p className="vl2-eyebrow">Membership</p>
              <h2 className="vl2-serif mt-3 text-2xl text-white sm:text-3xl">Membership plans are coming soon.</h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-white/55">
                We&apos;re putting the finishing touches on our membership tiers. Check back shortly — in the meantime,
                every registered customer already earns reward points on every order.
              </p>
              <Link
                href={isSignedInCustomer ? "/account" : "/account/login"}
                className="vl2-btn-primary vl-focus-ring mt-8 inline-flex items-center justify-center px-5 py-3 text-sm"
              >
                {isSignedInCustomer ? "View my rewards" : "Create a free account"}
              </Link>
            </div>
          </ScrollReveal>
        ) : (
          <>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="vl2-serif text-3xl text-white sm:text-4xl">Unlock Exclusive Researcher Benefits</h2>
          <p className="mt-3 text-sm leading-7 text-white/55">
            Save on every order, receive monthly store credit, get early access to limited releases, and enjoy premium member-only perks.
          </p>
        </div>

        <div className="mt-10 flex justify-center">
          <div className="inline-flex border border-white/15 p-1">
            <button
              type="button"
              onClick={() => setBillingCycle("monthly")}
              className={billingCycle === "monthly" ? "inline-flex items-center justify-center bg-white/10 px-4 py-2.5 text-sm min-h-[44px] text-white sm:px-5" : "inline-flex items-center justify-center px-4 py-2.5 text-sm min-h-[44px] text-white/50 sm:px-5"}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBillingCycle("annual")}
              className={billingCycle === "annual" ? "inline-flex items-center justify-center bg-white/10 px-4 py-2.5 text-sm min-h-[44px] text-white sm:px-5" : "inline-flex items-center justify-center px-4 py-2.5 text-sm min-h-[44px] text-white/50 sm:px-5"}
            >
              Annual <span className="text-emerald-300">(save ~17%)</span>
            </button>
          </div>
        </div>

        {/* On phones this is a snap-scrolling carousel (one plan at a time, next
            one peeking) so every tier is easy to see and compare without an
            endless vertical scroll; sm+ keeps the original 2-/4-up grid. The
            tier cards intentionally skip ScrollReveal here — its viewport
            IntersectionObserver would keep the off-screen carousel cards hidden
            until swiped into view. */}
        <div className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-pl-4 px-1 pb-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 sm:pt-0 lg:grid-cols-4">
          {tiers.filter((tier) => tier.slug !== "free").map((tier) => {
            const price = billingCycle === "monthly" ? tier.monthlyPriceCents : tier.annualPriceCents;
            const isFeatured = tier.slug === "pro";
            const annualSavingsCents = tier.monthlyPriceCents * 12 - tier.annualPriceCents;
            const showAnnualSavings = billingCycle === "annual" && price > 0 && annualSavingsCents > 0;
            const showComparePrice = billingCycle === "monthly" && tier.compareMonthlyPriceCents > tier.monthlyPriceCents;
            return (
              <div key={tier.id} className="w-[82%] shrink-0 snap-center sm:w-auto sm:shrink">
                <div
                  className={`vl2-product-card group relative flex h-full flex-col p-5 ${isFeatured ? "border-white/60 ring-1 ring-white/20" : ""}`}
                >
                  {isFeatured ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-black">
                      Most Popular
                    </span>
                  ) : null}

                  <p className="vl2-eyebrow">{tier.name}</p>
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-3xl text-white">
                    {showComparePrice ? (
                      <span className="text-base font-normal text-white/35 line-through">{money(tier.compareMonthlyPriceCents)}</span>
                    ) : null}
                    <span>{money(price)}</span>
                    {price > 0 ? <span className="text-sm font-normal text-white/40">/{billingCycle === "monthly" ? "mo" : "yr"}</span> : null}
                  </p>
                  {showAnnualSavings ? (
                    <p className="mt-1 text-xs font-semibold text-emerald-300">Save {money(annualSavingsCents)} vs monthly</p>
                  ) : null}

                  {price > 0 && tier.monthlyStoreCreditCents > 0 ? (
                    <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.06] px-4 py-3">
                      <p className="text-base font-bold text-emerald-300">{money(tier.monthlyStoreCreditCents)}/mo store credit</p>
                      <p className="text-[11px] text-white/45">
                        {tier.storeCreditMinOrderCents > 0
                          ? `redeem on orders of ${money(tier.storeCreditMinOrderCents)}+`
                          : "redeem on any order"}
                      </p>
                    </div>
                  ) : null}

                  <ul className="mt-6 flex-1 space-y-3 text-sm text-white/70">
                    {tier.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-start gap-2">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 h-4 w-4 flex-shrink-0 text-white">
                          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {benefit}
                      </li>
                    ))}
                  </ul>

                  {tier.slug === "free" ? (
                    <Link
                      href={isSignedInCustomer ? "/account" : "/account/login"}
                      className="vl2-btn-primary vl-focus-ring mt-8 inline-flex items-center justify-center px-5 py-3 text-sm"
                    >
                      {isSignedInCustomer ? "View my rewards" : "Get Started Free"}
                    </Link>
                  ) : (
                    <div className="mt-8">
                      <Link
                        href={
                          isSignedInCustomer
                            ? `/membership/${tier.slug}/subscribe`
                            : `/account/login?redirect=${encodeURIComponent(`/membership/${tier.slug}/subscribe`)}`
                        }
                        className="vl2-btn-secondary vl-focus-ring inline-flex w-full items-center justify-center px-5 py-3 text-sm"
                      >
                        Join {tier.name}
                      </Link>
                      <p className="mt-2 text-center text-[11px] text-white/40">$1 today, {tier.introDurationDays}-day intro, then {money(tier.monthlyPriceCents)}/month.</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-center text-[11px] uppercase tracking-[0.24em] text-white/40 sm:hidden">← Swipe to compare plans →</p>

        <ScrollReveal delayMs={80}>
          <div className="mt-16 border-2 border-amber-400/70 bg-gradient-to-br from-amber-950/40 via-black to-black p-6 sm:p-10">
            <p className="text-center text-xs font-bold uppercase tracking-[0.32em] text-amber-300">Elite Research Exclusive</p>
            <h2 className="vl2-serif mt-3 text-center text-3xl font-bold text-white sm:text-4xl">
              Exclusive Buy In Bulk Savings
            </h2>
            <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-3">
              <div className="border border-amber-400/40 bg-black/40 p-5 text-center">
                <p className="text-3xl font-bold text-amber-300">5% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of $500 or more</p>
              </div>
              <div className="border border-amber-400/40 bg-black/40 p-5 text-center">
                <p className="text-3xl font-bold text-amber-300">12% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of $1,000 or more</p>
              </div>
              <div className="border border-amber-400/40 bg-black/40 p-5 text-center">
                <p className="text-3xl font-bold text-amber-300">Free Shipping</p>
                <p className="mt-2 text-sm text-white/70">Included at every bulk tier</p>
              </div>
            </div>
            <ul className="mx-auto mt-8 max-w-2xl space-y-2 text-sm text-white/60">
              <li>• Discounts are automatically applied at checkout — no code needed.</li>
              <li>• Exclusive to active, paying Elite Research members (trial members qualify once they convert to a paying member).</li>
              <li>• One discount per order — bulk savings automatically applies if it beats any other discount you&apos;re eligible for.</li>
            </ul>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={100}>
          <div className="mt-16">
            <h2 className="vl2-serif text-center text-2xl text-white">Compare plans</h2>
            <div className="mt-6 overflow-x-auto border border-white/10">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-white/45">
                    <th className="px-5 py-4 font-normal">Benefit</th>
                    {tiers.map((tier) => (
                      <th key={tier.id} className="px-5 py-4 text-center font-normal text-white/70">{tier.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((row) => (
                    <tr key={row.label} className="border-b border-white/5">
                      <td className="px-5 py-3 text-white/60">{row.label}</td>
                      {tiers.map((tier) => (
                        <td key={tier.id} className="px-5 py-3 text-center text-white/70">{row.getValue(tier)}</td>
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
          </>
        )}

        <ScrollReveal delayMs={140}>
          <div className="mt-16">
            <h2 className="vl2-serif text-center text-2xl text-white">Frequently asked questions</h2>
            <div className="mx-auto mt-6 max-w-2xl">
              <FaqAccordion />
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
