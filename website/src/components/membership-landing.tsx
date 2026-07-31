"use client";

// The membership landing — designed to make joining feel like entering a
// club, not buying a discount. Everything is expressed in DOLLARS (what you
// pay, what you save, what today is worth), the strongest tier carries the
// social-proof badges, and a live calculator prices membership against the
// shopper's actual cart. No trial gimmicks: join today, cancel anytime,
// benefits start immediately.

import { useMemo, useState } from "react";
import Link from "next/link";
import type { MembershipTier } from "@/lib/membership";
import { ScrollReveal } from "@/components/scroll-reveal";
import { useCart, formatCartCurrency } from "@/components/cart-context";

type BillingCycle = "monthly" | "annual";

function money(cents: number) {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(2)}`;
}

function moneyWhole(cents: number) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

const FAQ_ITEMS = [
  {
    q: "When do my benefits start?",
    a: "Immediately. Member pricing, free shipping, priority processing, and your points multiplier are live from the moment you join — your very next order gets member treatment.",
  },
  {
    q: "Can I cancel or change my plan?",
    a: "Yes, any time from your account dashboard — no calls, no forms. Cancel before your next renewal date and you keep every benefit through the period you already paid for. No hidden fees, ever.",
  },
  {
    q: "Does my member discount combine with promo codes or other sales?",
    a: "No — exactly one discount applies per order, and discounts never stack. Your member pricing is applied automatically whenever you're signed in, no code needed. If a promo or ambassador code would save you more than your member discount, checkout automatically applies that better discount instead — you always get the single best deal without doing anything.",
  },
  {
    q: "How does the monthly store credit work?",
    a: "Paying tiers receive store credit every month, automatically applied at checkout once your order meets the tier's minimum. It's real money off your total, on top of your member pricing.",
  },
  {
    q: "How do reward points work?",
    a: "Every paid order earns points based on your membership tier (2x, 3x, or 5x points per $1 spent on the merchandise total). 100 points equals $1 in store credit, redeemable at checkout on any future order. Points never expire.",
  },
  {
    q: "Is billing live yet?",
    a: "The membership signup flow, billing schedule, and dashboard are fully built and active — a payment processor isn't connected yet, so a card can't be charged until that's finished. Signing up saves your membership request, and billing begins automatically the moment a processor is connected.",
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 flex-shrink-0 text-white/70 transition-transform ${isOpen ? "rotate-180" : ""}`}>
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

// "Best for" personas by tier strength (cheapest paid tier → strongest), so
// cards answer "which one is me?" instead of listing generic bullets.
const BEST_FOR_BY_RANK: string[][] = [
  ["Occasional orders", "First-time members", "1–2 products a month"],
  ["Monthly buyers", "Researchers restocking regularly", "2–4 products a month"],
  ["High-volume researchers", "Bulk and team orders", "Weekly ordering"],
];

// ——— Live savings calculator ————————————————————————————————————————————
// Prices membership against the shopper's REAL cart (live — updates as items
// are added). With an empty cart it falls back to a spend slider so the page
// still demonstrates value.
function SavingsCalculator({ tiers }: { tiers: MembershipTier[] }) {
  const { subtotal, shipping } = useCart();
  const paidTiers = tiers.filter((tier) => tier.monthlyPriceCents > 0);
  const [tierSlug, setTierSlug] = useState(paidTiers.find((t) => t.slug === "pro")?.slug ?? paidTiers[0]?.slug ?? "");
  const [simulatedSpend, setSimulatedSpend] = useState(200);

  const tier = paidTiers.find((t) => t.slug === tierSlug) ?? paidTiers[0];
  if (!tier) return null;

  const usingCart = subtotal > 0;
  const basis = usingCart ? subtotal : simulatedSpend;
  const basisShipping = usingCart ? shipping : basis >= 250 ? 0 : 15;

  const discountSavings = Math.round(basis * tier.memberDiscountPercent) / 100;
  const shippingSavings = tier.freeShipping ? basisShipping : 0;
  const credit = Math.round(basis * 100) >= tier.storeCreditMinOrderCents ? tier.monthlyStoreCreditCents / 100 : 0;
  const monthlyCost = tier.monthlyPriceCents / 100;
  const totalBenefit = Math.round((discountSavings + shippingSavings + credit) * 100) / 100;
  const todayValue = Math.round((totalBenefit - monthlyCost) * 100) / 100;

  const row = (label: string, value: string, tone: "plus" | "minus" | "muted" = "muted") => (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <span className="text-white/60">{label}</span>
      <span className={`tabular-nums font-medium ${tone === "plus" ? "text-emerald-300/80" : tone === "minus" ? "text-white/70" : "text-white"}`}>{value}</span>
    </div>
  );

  return (
    <div className="vl2-glass p-6 sm:p-8">
      <p className="vl2-eyebrow">Live savings calculator</p>
      <h3 className="vl2-serif mt-2 text-2xl text-white">What membership is worth to you — today</h3>

      {usingCart ? (
        <p className="mt-2 text-xs text-white/45">Calculated from your current cart. Add or remove products and this updates instantly.</p>
      ) : (
        <label className="mt-5 block text-sm text-white/60">
          Your typical monthly order: <span className="font-semibold text-white">${simulatedSpend}</span>
          <input
            type="range"
            min={50}
            max={1000}
            step={10}
            value={simulatedSpend}
            onChange={(event) => setSimulatedSpend(Number(event.target.value))}
            className="mt-3 w-full accent-white"
          />
        </label>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        {paidTiers.map((paidTier) => (
          <button
            key={paidTier.slug}
            type="button"
            onClick={() => setTierSlug(paidTier.slug)}
            className={paidTier.slug === tier.slug
              ? "border border-white bg-white/10 px-4 py-2 text-xs font-semibold text-white"
              : "border border-white/15 px-4 py-2 text-xs text-white/55 transition hover:border-white/35 hover:text-white"}
          >
            {paidTier.name}
          </button>
        ))}
      </div>

      <div className="mt-6 divide-y divide-white/5 border-t border-white/10">
        {row(usingCart ? "Current cart" : "Monthly orders", formatCartCurrency(basis))}
        {row(`Member pricing (${tier.memberDiscountPercent}% off)`, `−${formatCartCurrency(discountSavings)}`, "plus")}
        {tier.freeShipping ? row("Free shipping", shippingSavings > 0 ? `−${formatCartCurrency(shippingSavings)}` : "Included", "plus") : null}
        {tier.monthlyStoreCreditCents > 0
          ? row(
              "Monthly store credit",
              credit > 0 ? `+${formatCartCurrency(credit)}` : `+${money(tier.monthlyStoreCreditCents)} on ${money(tier.storeCreditMinOrderCents)}+ orders`,
              credit > 0 ? "plus" : "muted",
            )
          : null}
        {row(`${tier.name} membership`, `−${formatCartCurrency(monthlyCost)}/mo`, "minus")}
      </div>

      <div className={`mt-4 flex items-center justify-between rounded-xl border px-4 py-3.5 ${todayValue >= 0 ? "border-emerald-400/25 bg-emerald-400/[0.07]" : "border-white/10 bg-white/[0.03]"}`}>
        <span className="text-sm font-semibold text-white">{usingCart ? "Joining today is worth" : "Each month, membership is worth"}</span>
        <span className={`text-xl font-bold tabular-nums ${todayValue >= 0 ? "text-emerald-300" : "text-white/70"}`}>
          {todayValue >= 0 ? "+" : "−"}{formatCartCurrency(Math.abs(todayValue))}
        </span>
      </div>
      {todayValue >= 0 ? (
        <p className="mt-2 text-xs text-white/45">The membership pays for itself on this order alone — everything after is pure savings.</p>
      ) : (
        <p className="mt-2 text-xs text-white/45">Add {formatCartCurrency(Math.max(0, Math.ceil(((monthlyCost - credit - shippingSavings) / Math.max(0.01, tier.memberDiscountPercent / 100) - basis) * 100) / 100))} more to your cart and membership pays for itself today.</p>
      )}
    </div>
  );
}

export function MembershipLanding({ tiers, isSignedInCustomer }: { tiers: MembershipTier[]; isSignedInCustomer: boolean }) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");

  const paidTiers = useMemo(
    () => tiers.filter((tier) => tier.slug !== "free" && tier.monthlyPriceCents > 0).sort((a, b) => a.monthlyPriceCents - b.monthlyPriceCents),
    [tiers],
  );
  const strongestSlug = useMemo(
    () => (paidTiers.length ? paidTiers.reduce((best, t) => (t.memberDiscountPercent > best.memberDiscountPercent ? t : best)).slug : null),
    [paidTiers],
  );

  const comparisonRows = useMemo(() => [
    { label: "Member pricing", getValue: (tier: MembershipTier) => (tier.memberDiscountPercent > 0 ? `${tier.memberDiscountPercent}% off everything` : "—") },
    { label: "Monthly store credit", getValue: (tier: MembershipTier) => (tier.monthlyStoreCreditCents > 0 ? `${money(tier.monthlyStoreCreditCents)}/mo` : "—") },
    { label: "Points per $1", getValue: (tier: MembershipTier) => `${tier.pointsPerDollar}x` },
    { label: "Free shipping", getValue: (tier: MembershipTier) => (tier.freeShipping ? "✓" : "—") },
    { label: "Priority processing", getValue: (tier: MembershipTier) => (tier.priorityShipping ? "✓" : "—") },
    { label: "Early access", getValue: (tier: MembershipTier) => (tier.earlyAccess ? "✓" : "—") },
    { label: "Referral bonus", getValue: (tier: MembershipTier) => `${tier.referralBonusPoints} pts` },
  ], []);

  return (
    <div className="relative z-10 px-4 pb-24 pt-24 sm:px-6 sm:pt-28 lg:px-12">
      <div className="mx-auto max-w-6xl">
        {tiers.length === 0 ? (
          <>
          <ScrollReveal>
            <div className="text-center">
              <p className="vl2-eyebrow">Vanta Labs Membership</p>
              <h1 className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Membership &amp; Rewards</h1>
            </div>
          </ScrollReveal>
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
          </>
        ) : (
          <>
        {/* Hero: the club, not the coupon. */}
        <div className="mx-auto max-w-2xl text-center">
          <p className="vl2-eyebrow">Vanta Labs Membership</p>
          <h1 className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">The inner circle of research.</h1>
          <p className="mt-3 text-sm leading-7 text-white/55">
            Member pricing on every vial, monthly store credit, free priority shipping, and first access to new
            compounds — a membership that pays for itself on your first order.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
            <span>✓ Join today</span>
            <span>✓ Cancel anytime</span>
            <span>✓ Benefits start immediately</span>
            <span>✓ No hidden fees</span>
          </div>
        </div>

        <div className="mt-8 flex justify-center">
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
              Annual <span className="ml-1.5 rounded-full border border-emerald-300/25 px-2 py-0.5 text-[10px] font-medium text-emerald-300/90">2 months free</span>
            </button>
          </div>
        </div>

        {/* Tier cards: cost, credit, real average savings, and who it's for. */}
        <div className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-pl-4 px-1 pb-2 pt-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 sm:pt-0 lg:grid-cols-4">
          {paidTiers.map((tier, index) => {
            const price = billingCycle === "monthly" ? tier.monthlyPriceCents : tier.annualPriceCents;
            const isFeatured = tier.slug === "pro";
            const isBestValue = tier.slug === strongestSlug && !isFeatured;
            const annualSavingsCents = tier.monthlyPriceCents * 12 - tier.annualPriceCents;
            const showAnnualSavings = billingCycle === "annual" && price > 0 && annualSavingsCents > 0;
            const showComparePrice = billingCycle === "monthly" && tier.compareMonthlyPriceCents > tier.monthlyPriceCents;
            // Honest "average monthly savings" at a $200/mo order pace:
            // member discount + store credit (labeled with its basis below).
            const avgMonthlySavingsCents = Math.round(20000 * (tier.memberDiscountPercent / 100)) + tier.monthlyStoreCreditCents;
            const bestFor = BEST_FOR_BY_RANK[Math.min(index, BEST_FOR_BY_RANK.length - 1)];
            return (
              <div key={tier.id} className="w-[82%] shrink-0 snap-center sm:w-auto sm:shrink">
                <div
                  className={`vl2-product-card group relative flex h-full flex-col p-6 sm:p-7 ${isFeatured ? "border-white/45" : isBestValue ? "border-white/25" : ""}`}
                >
                  {isFeatured ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap border border-white/30 bg-[#101014] px-4 py-1 text-[9px] font-medium uppercase tracking-[0.3em] text-white/90">
                      Most Popular
                    </span>
                  ) : isBestValue ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap border border-emerald-300/30 bg-[#101014] px-4 py-1 text-[9px] font-medium uppercase tracking-[0.3em] text-emerald-200/90">
                      Best Value
                    </span>
                  ) : null}

                  <p className="vl2-eyebrow">Membership</p>
                  <h3 className="vl2-serif mt-1.5 text-2xl text-white">{tier.name}</h3>
                  <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-4xl text-white vl2-serif">
                    {showComparePrice ? (
                      <span className="text-base font-normal text-white/35 line-through">{money(tier.compareMonthlyPriceCents)}</span>
                    ) : null}
                    <span>{money(price)}</span>
                    {price > 0 ? <span className="text-sm font-normal text-white/45">/{billingCycle === "monthly" ? "mo" : "yr"}</span> : null}
                  </p>
                  {showAnnualSavings ? (
                    <p className="mt-1 text-xs text-white/55">Save {money(annualSavingsCents)} a year · lock in current pricing</p>
                  ) : null}

                  {tier.memberDiscountPercent > 0 ? (
                    <div className="mt-5 border border-white/10 bg-white/[0.03] px-4 py-3.5">
                      <p className="text-sm font-semibold text-white">{tier.memberDiscountPercent}% member pricing</p>
                      <p className="text-[11px] text-white/45">pay {moneyWhole(10000 - Math.round(10000 * (tier.memberDiscountPercent / 100)))} on every $100, on everything</p>
                    </div>
                  ) : null}

                  {tier.monthlyStoreCreditCents > 0 ? (
                    <div className="mt-2 border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-3.5">
                      <p className="text-sm font-semibold text-emerald-300/90">{money(tier.monthlyStoreCreditCents)}/mo store credit</p>
                      <p className="text-[11px] text-white/45">
                        {tier.storeCreditMinOrderCents > 0
                          ? `redeem on orders of ${money(tier.storeCreditMinOrderCents)}+`
                          : "redeem on any order"}
                      </p>
                    </div>
                  ) : null}

                  {avgMonthlySavingsCents > 0 ? (
                    <p className="mt-3 text-xs text-white/60">
                      ≈ {money(avgMonthlySavingsCents)}/mo in savings <span className="text-white/35">at $200/mo in orders</span>
                    </p>
                  ) : null}

                  <div className="mt-4">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Best for</p>
                    <ul className="mt-1.5 space-y-1 text-xs text-white/60">
                      {bestFor.map((line) => (
                        <li key={line}>• {line}</li>
                      ))}
                    </ul>
                  </div>

                  <ul className="mt-6 flex-1 space-y-3 border-t border-white/10 pt-5 text-sm leading-6 text-white/70">
                    {tier.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-start gap-2.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-300/70">
                          <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        {/* Strip any leading emoji/symbols from admin-entered benefit copy —
                            the gold check is the icon; doubled glyphs read as clutter. */}
                        <span>{benefit.replace(/^[^\p{L}\p{N}$]+\s*/u, "")}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-6">
                    <Link
                      href={
                        isSignedInCustomer
                          ? `/membership/${tier.slug}/subscribe`
                          : `/account/login?redirect=${encodeURIComponent(`/membership/${tier.slug}/subscribe`)}`
                      }
                      className={`vl-focus-ring inline-flex w-full items-center justify-center px-5 py-3 text-sm ${isFeatured || isBestValue ? "vl2-btn-primary" : "vl2-btn-secondary"}`}
                    >
                      Join {tier.name}
                    </Link>
                    <p className="mt-2.5 text-center text-[10px] uppercase tracking-[0.14em] text-white/40">Join today · Cancel anytime · Benefits start immediately</p>
                    {!isSignedInCustomer ? (
                      <p className="mt-1 text-center text-[10px] text-white/35">Free account included — track your savings, credit &amp; points in your dashboard</p>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-center text-[11px] uppercase tracking-[0.24em] text-white/70 sm:hidden">← Swipe to compare plans →</p>

        {/* Live calculator — right under the cards, priced off the real cart. */}
        <ScrollReveal delayMs={60}>
          <div className="mt-14">
            <SavingsCalculator tiers={tiers} />
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={80}>
          <div className="mt-14 border-t border-white/10 pt-10 text-center">
            <p className="vl2-eyebrow">How membership works</p>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/60 sm:text-base">
              Join in one click and your benefits are live immediately: member pricing on every product, monthly store
              credit, points on every order, and priority handling. Cancel anytime from your dashboard — you keep every
              benefit through the period you&apos;ve paid for.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-x-8 gap-y-2 text-[10px] uppercase tracking-[0.14em] text-white/45">
              <span>Cancel Anytime</span>
              <span>No Hidden Fees</span>
              <span>Secure Checkout</span>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={80}>
          <div className="mt-16 border border-white/15 bg-white/[0.02] p-6 sm:p-10">
            <p className="text-center text-[10px] font-medium uppercase tracking-[0.32em] text-white/45">Elite Research Exclusive</p>
            <h2 className="vl2-serif mt-3 text-center text-3xl font-bold text-white sm:text-4xl">
              Exclusive Buy In Bulk Savings
            </h2>
            <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:grid-cols-3">
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">5% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of $500 or more</p>
              </div>
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">12% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of $1,000 or more</p>
              </div>
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">Free Shipping</p>
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
