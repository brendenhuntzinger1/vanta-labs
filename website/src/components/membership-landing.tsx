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
import { POINTS_PER_DOLLAR_REDEMPTION } from "@/lib/points-math";
import { DEFAULT_BULK_SAVINGS_CONFIG, type BulkSavingsConfig } from "@/lib/bulk-savings";
import { ScrollReveal } from "@/components/scroll-reveal";
import { useCart, formatCartCurrency } from "@/components/cart-context";
// Shared with checkout so the calculator's shipping assumption always matches
// what an order is actually charged.

type BillingCycle = "monthly" | "annual";

function money(cents: number) {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(2)}`;
}

function moneyWhole(cents: number) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// The FAQ quotes numbers the tiers really carry, so an edit in /admin/membership
// cannot leave the answers behind. Hard-coded copy had already drifted here: the
// points answer said "2x, 3x, or 5x" while the seeded tiers are 2/3/4/5, so
// Elite's 4x was missing from the only place a shopper reads the range in prose
// (the comparison table further down prints every tier's real figure).
export function buildFaqItems(tiers: MembershipTier[]) {
  const multipliers = tiers.map((tier) => tier.pointsPerDollar).filter((value) => value > 0);
  const multiplierRange = multipliers.length
    ? `${Math.min(...multipliers)}x to ${Math.max(...multipliers)}x points`
    : "points";

  return [
    {
      q: "When do my benefits start?",
      // Free shipping and priority processing are per-tier columns, not universal
      // — Essential is seeded with both off — so promising them to everyone who
      // joins contradicts the very card the shopper is reading them next to.
      a: "Immediately. Member pricing and your points multiplier are live from the moment you join, along with every other benefit your tier includes — your very next order gets member treatment.",
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
      a: `Every paid order earns points based on your membership tier (${multiplierRange} per $1 spent on the merchandise total). ${POINTS_PER_DOLLAR_REDEMPTION} points equals $1 in store credit, redeemable at checkout on any future order. Points never expire.`,
    },
    {
      q: "Is billing live yet?",
      a: "The membership signup flow, billing schedule, and dashboard are fully built and active — a payment processor isn't connected yet, so a card can't be charged until that's finished. Signing up saves your membership request, and billing begins automatically the moment a processor is connected.",
    },
  ];
}

/**
 * THE ANSWERS ARE ALWAYS IN THE DOCUMENT. THEY USED TO BE MOUNTED ON CLICK.
 *
 * `{isOpen ? <p>{item.a}</p> : null}` meant five of the six answers did not
 * exist in the HTML at all — and Googlebot does not click. Measured against
 * production: 204 words, a fifth of this page's own prose, describing
 * cancellation, discount stacking, store credit, reward points and billing
 * status. The only answer a crawler received was the one that happens to open
 * by default.
 *
 * Same defect and same fix as the product page's tabs and FAQ
 * (components/product-detail-client.tsx): render every answer, hide the closed
 * ones with the `hidden` attribute. `hidden` deliberately — it is display:none,
 * so a closed answer leaves the tab order and the accessibility tree instead of
 * becoming text a keyboard user can reach but not see.
 */
function FaqAccordion({ items }: { items: ReturnType<typeof buildFaqItems> }) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <div className="space-y-3">
      {items.map((item, index) => {
        const isOpen = openIndex === index;
        const questionId = `membership-faq-q${index}`;
        const answerId = `membership-faq-a${index}`;
        return (
          <div key={item.q} className="border border-white/10 bg-black/30">
            <button
              type="button"
              id={questionId}
              onClick={() => setOpenIndex(isOpen ? null : index)}
              className="vl-focus-ring flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
              aria-expanded={isOpen}
              aria-controls={answerId}
            >
              <span className="text-sm text-white">{item.q}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`h-4 w-4 flex-shrink-0 text-white/70 transition-transform ${isOpen ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <p
              id={answerId}
              role="region"
              aria-labelledby={questionId}
              hidden={!isOpen}
              className="px-5 pb-4 text-sm leading-6 text-white/55"
            >
              {item.a}
            </p>
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

// The admin-authored benefit bullets restate what the structured card already
// shows — "5% member discount on all products" next to a 5% MEMBER PRICING box,
// "$5 monthly store credit" next to a $5.00/MO STORE CREDIT box, "Priority order
// processing" next to Processing · Priority. Every card was saying the same
// handful of facts three times over.
//
// Drop a bullet only when it clearly restates a fact the card already displays
// structurally. Conservative on purpose: an unrecognised bullet is KEPT, because
// hiding a real perk is worse than showing one twice.
function restatesStructuredPerk(benefit: string, tier: MembershipTier): boolean {
  const text = benefit.toLowerCase();
  const has = (...words: string[]) => words.every((w) => text.includes(w));

  if (tier.memberDiscountPercent > 0 && (has("member", "discount") || has("member", "pricing") || has(`${tier.memberDiscountPercent}%`))) return true;
  if (tier.monthlyStoreCreditCents > 0 && has("store credit")) return true;
  if (tier.freeShipping && has("free", "shipping")) return true;
  if (tier.priorityShipping && (has("priority", "processing") || has("priority", "order"))) return true;
  if (tier.earlyAccess && has("early access")) return true;
  if (tier.referralBonusPoints > 0 && has("referral")) return true;
  if (has("points", "per $1") || has("point", "multiplier")) return true;

  return false;
}

/**
 * The bullets a tier actually shows, after the de-duplication above.
 *
 * Exported and shared because the list and its "See all N benefits" toggle used
 * to compute this filter separately, and a count that disagrees with the list
 * it opens is the one thing a toggle must never do. It also has to be reachable
 * from a test: rendering the landing page needs a CartProvider, so the only
 * practical way to pin the empty case is to pin this.
 *
 * Returning [] is a real state, not just a seeding artefact — a tier whose
 * every bullet restates a structured perk (a plausible "10% member discount /
 * Free shipping / 1x points per $1" set) filters down to nothing, and the
 * caller must render no toggle rather than an empty one offering "0 benefits".
 */
export function visibleBenefits(tier: MembershipTier): string[] {
  return tier.benefits.filter((benefit) => !restatesStructuredPerk(benefit, tier));
}

// ——— Live savings calculator ————————————————————————————————————————————
// Prices membership against the shopper's REAL cart (live — updates as items
// are added). With an empty cart it falls back to a spend slider so the page
// still demonstrates value.
function SavingsCalculator({ tiers }: { tiers: MembershipTier[] }) {
  const { subtotal, shipping, shippingConfig } = useCart();
  const paidTiers = tiers.filter((tier) => tier.monthlyPriceCents > 0);
  const [tierSlug, setTierSlug] = useState(paidTiers.find((t) => t.slug === "pro")?.slug ?? paidTiers[0]?.slug ?? "");
  const [simulatedSpend, setSimulatedSpend] = useState(200);

  const tier = paidTiers.find((t) => t.slug === tierSlug) ?? paidTiers[0];
  if (!tier) return null;

  const usingCart = subtotal > 0;
  const basis = usingCart ? subtotal : simulatedSpend;
  const basisShipping = usingCart
    ? shipping
    : basis >= shippingConfig.freeShippingThreshold
      ? 0
      : shippingConfig.domesticFee;

  const discountSavings = Math.round(basis * tier.memberDiscountPercent) / 100;
  const shippingSavings = tier.freeShipping ? basisShipping : 0;
  const credit = Math.round(basis * 100) >= tier.storeCreditMinOrderCents ? tier.monthlyStoreCreditCents / 100 : 0;
  const monthlyCost = tier.monthlyPriceCents / 100;
  const totalBenefit = Math.round((discountSavings + shippingSavings + credit) * 100) / 100;
  const todayValue = Math.round((totalBenefit - monthlyCost) * 100) / 100;

  const row = (label: string, value: string, tone: "plus" | "minus" | "muted" = "muted") => (
    <div className="flex items-center justify-between py-2.5 text-sm">
      <span className="text-white/60">{label}</span>
      <span className={`tabular-nums font-medium ${tone === "plus" ? "text-[color:var(--accent-gold)]/80" : tone === "minus" ? "text-white/70" : "text-white"}`}>{value}</span>
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

      <div className={`mt-4 flex items-center justify-between rounded-xl border px-4 py-3.5 ${todayValue >= 0 ? "border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.07]" : "border-white/10 bg-white/[0.03]"}`}>
        <span className="text-sm font-semibold text-white">{usingCart ? "Joining today is worth" : "Each month, membership is worth"}</span>
        <span className={`text-xl font-bold tabular-nums ${todayValue >= 0 ? "text-[color:var(--accent-gold)]" : "text-white/70"}`}>
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

export function MembershipLanding({ tiers, isSignedInCustomer, loadFailed = false, bulkSavings = DEFAULT_BULK_SAVINGS_CONFIG }: { tiers: MembershipTier[]; isSignedInCustomer: boolean; loadFailed?: boolean; bulkSavings?: BulkSavingsConfig }) {
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("monthly");
  // Per-tier benefit-list disclosure, mobile only (see the toggle below).
  const [expandedBenefits, setExpandedBenefits] = useState<Record<string, boolean>>({});

  const paidTiers = useMemo(
    () => tiers.filter((tier) => tier.slug !== "free" && tier.monthlyPriceCents > 0).sort((a, b) => a.monthlyPriceCents - b.monthlyPriceCents),
    [tiers],
  );
  const faqItems = useMemo(() => buildFaqItems(tiers), [tiers]);
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
    <div className="relative z-10 px-4 pb-24 pt-16 sm:px-6 sm:pt-28 lg:px-12">
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
              {/* Two different problems. Saying "coming soon" when the plans
                  exist but could not be loaded tells the visitor the store is
                  unfinished, and tells the owner nothing. */}
              <h2 className="vl2-serif mt-3 text-2xl text-white sm:text-3xl">
                {loadFailed ? "Membership is briefly unavailable." : "Membership plans are coming soon."}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-white/55">
                {loadFailed
                  ? "We could not load the membership plans just now. Please try again in a moment — your account and reward points are unaffected."
                  : "We’re putting the finishing touches on our membership tiers. Check back shortly — in the meantime, every registered customer already earns reward points on every order."}
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
          <h1 className="vl2-serif mt-3 text-[2rem] leading-[1.12] text-white sm:mt-4 sm:text-5xl">The inner circle of research.</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/55">
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
              Annual <span className="ml-1.5 rounded-full border border-[color:var(--accent-gold)]/25 px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent-gold)]">2 months free</span>
            </button>
          </div>
        </div>

        {/* Tier cards: cost, credit, real average savings, and who it's for.
            Stacked vertically on mobile — the old horizontal carousel showed
            one plan at a time, so plans 2-4 were invisible until you happened
            to swipe, and you could never compare two side by side. */}
        {/* The grid was fixed at 4 columns, so a 3-tier program sat left-aligned
            with an empty fourth slot. Column count now follows the number of
            tiers and the track is centred, so three tiers land in the middle of
            the screen and four still fill the row. */}
        {/* Each tier card titles itself with an h3, so the plans need a section
            heading of their own or the outline jumps straight from the page h1. */}
        <h2 id="membership-plans-heading" className="sr-only">Membership plans</h2>
        <div
          aria-labelledby="membership-plans-heading"
          className={`mx-auto mt-8 grid grid-cols-1 justify-center gap-4 pt-4 sm:grid-cols-2 ${
            paidTiers.length === 3 ? "lg:max-w-5xl lg:grid-cols-3" : "lg:grid-cols-4"
          }`}
        >
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
            // Computed once and shared with the toggle below, so the count in
            // "See all N benefits" can never disagree with the list it opens.
            const shownBenefits = visibleBenefits(tier);
            return (
              <div key={tier.id}>
                <div
                  className={`vl2-product-card group relative flex h-full flex-col p-6 sm:p-7 ${isFeatured || isBestValue ? "vl-tier-glow vl-tier-glow-featured" : "vl-tier-glow"}`}
                >
                  {isFeatured ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap border border-[color:var(--accent-gold)]/40 bg-[#0a0a0a] px-4 py-1 text-[9px] font-medium uppercase tracking-[0.3em] text-[color:var(--accent-gold)] shadow-[0_0_10px_-6px_rgba(199,174,94,0.55)]">
                      Most Popular
                    </span>
                  ) : isBestValue ? (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap border border-[color:var(--accent-gold)]/30 bg-[#0a0a0a] px-4 py-1 text-[9px] font-medium uppercase tracking-[0.3em] text-[color:var(--accent-gold)]">
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
                    <div className="mt-2 border border-[color:var(--accent-gold)]/20 bg-[color:var(--accent-gold)]/[0.05] px-4 py-3.5">
                      <p className="text-sm font-semibold text-[color:var(--accent-gold)]">{money(tier.monthlyStoreCreditCents)}/mo store credit</p>
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

                  {/* EXACTLY what this tier grants, read from the tier's own
                      fields — the same numbers getMembershipPerks enforces at
                      checkout. The free-text benefit bullets below are
                      admin-authored copy and can drift from reality; these
                      cannot, so a shopper always sees the real discount, the
                      real credit, and its true minimum-order condition. */}
                  <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">What you get</p>
                    <dl className="mt-2 space-y-1.5 text-xs">
                      {/* Member pricing and store credit are DELIBERATELY absent:
                          both are already the two highlight boxes immediately
                          above. Repeating them here (and again in the bullets
                          below) put the same two facts on the card three times. */}
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-white/55">Points</dt>
                        <dd className="font-semibold text-white">{tier.pointsPerDollar}× per $1</dd>
                      </div>
                      {tier.freeShipping ? (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-white/55">Shipping</dt>
                          <dd className="font-semibold text-white">Free, every order</dd>
                        </div>
                      ) : null}
                      {tier.priorityShipping ? (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-white/55">Processing</dt>
                          <dd className="font-semibold text-white">Priority</dd>
                        </div>
                      ) : null}
                      {tier.earlyAccess ? (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-white/55">New releases</dt>
                          <dd className="font-semibold text-white">Early access</dd>
                        </div>
                      ) : null}
                      {tier.referralBonusPoints > 0 ? (
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="text-white/55">Referral bonus</dt>
                          <dd className="font-semibold text-white">{tier.referralBonusPoints.toLocaleString("en-US")} pts</dd>
                        </div>
                      ) : null}
                    </dl>
                    {tier.monthlyStoreCreditCents > 0 ? (
                      <p className="mt-2.5 border-t border-white/10 pt-2 text-[10px] leading-4 text-white/40">
                        Store credit is granted monthly and does not roll over.
                      </p>
                    ) : null}
                  </div>

                  {/* Full benefit list. A tier can carry 11 bullets, which made
                      each card taller than a phone screen — so on mobile it is
                      collapsed behind a toggle and the headline value (price,
                      discount, credit) stays visible. Always open from sm up,
                      where there is room for it. */}
                  <div className={`${expandedBenefits[tier.id] ? "block" : "hidden"} sm:block sm:flex-1`}>
                    <ul className="mt-5 space-y-3 border-t border-white/10 pt-5 text-sm leading-6 text-white/70 sm:mt-6">
                      {shownBenefits.map((benefit) => (
                        <li key={benefit} className="flex items-start gap-2.5">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[color:var(--accent-gold)]/70">
                            <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {/* Strip any leading emoji/symbols from admin-entered benefit copy —
                              the gold check is the icon; doubled glyphs read as clutter. */}
                          <span>{benefit.replace(/^[^\p{L}\p{N}$]+\s*/u, "")}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* No bullets left to reveal means no toggle. It used to render
                      unconditionally, so such a tier offered "See all 0 benefits"
                      and opened onto a blank list. */}
                  {shownBenefits.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setExpandedBenefits((prev) => ({ ...prev, [tier.id]: !prev[tier.id] }))}
                      aria-expanded={Boolean(expandedBenefits[tier.id])}
                      className="vl-focus-ring mt-4 flex w-full items-center justify-center gap-1.5 border-t border-white/10 pt-4 text-xs text-[color:var(--accent-gold)] sm:hidden"
                    >
                      {expandedBenefits[tier.id] ? "Hide benefits" : `See all ${shownBenefits.length} benefits`}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`h-3.5 w-3.5 transition-transform duration-200 ${expandedBenefits[tier.id] ? "rotate-180" : ""}`} aria-hidden>
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  ) : null}

                  <div className="mt-6">
                    <Link
                      href={
                        isSignedInCustomer
                          ? `/membership/${tier.slug}/subscribe`
                          : `/account/login?next=${encodeURIComponent(`/membership/${tier.slug}/subscribe`)}`
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

        {/* Live calculator — right under the cards, priced off the real cart. */}
        <ScrollReveal delayMs={60}>
          <div className="mt-14">
            <SavingsCalculator tiers={tiers} />
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={80}>
          <div className="mt-14 border-t border-white/10 pt-10 text-center">
            <p className="vl2-eyebrow">How membership works</p>
            {/* Same correction as the "When do my benefits start?" answer:
                priority handling is a per-tier column (Essential is seeded with
                it off), so it cannot go in a list of what EVERY member gets on
                joining. */}
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-white/60 sm:text-base">
              Join in one click and your benefits are live immediately: member pricing on every product, monthly store
              credit, and points on every order. Cancel anytime from your dashboard — you keep every
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
              {/* The four numbers below are the ones calculateBulkSavingsDiscount
                  actually applies at checkout, passed down from the admin control
                  config — not a second hand-written copy of them. Hard-coded
                  "5% / $500 / 12% / $1,000" advertised a program the admin can
                  retune in /admin/control, with nothing to keep the two in step. */}
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">{bulkSavings.tier1Percent}% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of ${bulkSavings.tier1Threshold.toLocaleString("en-US")} or more</p>
              </div>
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">{bulkSavings.tier2Percent}% OFF</p>
                <p className="mt-2 text-sm text-white/70">Orders of ${bulkSavings.tier2Threshold.toLocaleString("en-US")} or more</p>
              </div>
              <div className="border border-white/12 bg-black/40 p-5 text-center">
                <p className="vl2-serif text-3xl text-white">Free Shipping</p>
                <p className="mt-2 text-sm text-white/70">Included at every bulk tier</p>
              </div>
            </div>
            <ul className="mx-auto mt-8 max-w-2xl space-y-2 text-sm text-white/60">
              <li>• Discounts are automatically applied at checkout — no code needed.</li>
              <li>• Exclusive to active, paying Elite and Black members (trial members qualify once they convert to a paying member).</li>
              <li>• One discount per order — bulk savings automatically applies if it beats any other discount you&apos;re eligible for.</li>
            </ul>
          </div>
        </ScrollReveal>

        <ScrollReveal delayMs={100}>
          <div className="mt-16">
            <h2 className="vl2-serif text-center text-2xl text-white">Compare plans</h2>
            {/* Side-by-side comparison needs width it cannot have on a phone —
                five columns at a 560px minimum meant every mobile visitor got a
                horizontally-scrolling table, with the strongest tiers hidden off
                the right edge where most people never look. The tier cards above
                already state every one of these values per tier, so on mobile
                this is redundant rather than missing. Shown from sm up, where
                there is room to read it. */}
            <p className="mt-3 text-center text-sm text-white/45 sm:hidden">
              Every benefit is listed on each plan above.
            </p>
            <div className="mt-6 hidden overflow-x-auto border border-white/10 sm:block">
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
              <FaqAccordion items={faqItems} />
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
