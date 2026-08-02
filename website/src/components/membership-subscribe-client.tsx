"use client";

import { useState } from "react";
import nextDynamic from "next/dynamic";
import type { MembershipCardConfig } from "@/components/membership-card-form";

// Browser-only: the Basis Theory SDK touches `window` at module scope, so it
// must never be pulled into the server render.
const MembershipCardForm = nextDynamic(() => import("@/components/membership-card-form"), {
  ssr: false,
  loading: () => <p className="text-sm text-white/60">Loading secure card entry…</p>,
});
import { useRouter } from "next/navigation";
import type { MembershipTier } from "@/lib/membership";
import { MembershipPaymentMethodPlaceholder } from "@/components/membership-payment-method";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function MembershipSubscribeClient({ tier }: { tier: MembershipTier }) {
  const router = useRouter();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("annual");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "success">("idle");
  // Non-null once a Veyra session + BT public key have been minted: the card
  // form takes over from here and creates the recurring subscription.
  const [cardConfig, setCardConfig] = useState<MembershipCardConfig | null>(null);

  // Intro/trial flow removed per the owner: every signup charges the full
  // period immediately and benefits start the moment the charge succeeds.
  const usesIntroOffer = false;
  void tier.introOfferEnabled;
  // Show the ACTUAL charged monthly price. Membership charges are billed at the
  // base price (no card fee is added — see membership-billing.ts), so the old
  // "+5% card fee" display over-stated the price and contradicted the receipt.
  const monthlyPrice = tier.monthlyPriceCents;

  // Both cycles are billed to a card through the payment processor. Annual is a
  // single charge for the year (no auto-renew); monthly recurs until canceled.
  // Until the processor is connected the request is saved and nothing is
  // charged — the server reports that back so we never claim a false charge.
  const startMembership = async () => {
    const termsCopy = billingCycle === "annual"
      ? "Please agree to the annual (non-refundable) terms to continue."
      : "Please agree to the recurring billing terms to continue.";
    if (!agreedToTerms) {
      setMessage(termsCopy);
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    try {
      // Preferred lane: capture a card here and create a REAL recurring
      // subscription at the processor. Without this the fallback below hands the
      // shopper a one-time hosted checkout, which charges once and flips the
      // membership flag — month 2 never bills. (Same defect Refined shipped and
      // had to be re-ported off, 2026-07-16.)
      const cardCfgRes = await fetch("/api/membership/card-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, billingCycle }),
      });

      if (cardCfgRes.ok) {
        const cfg = (await cardCfgRes.json()) as MembershipCardConfig;
        if (cfg?.apiKey && cfg?.sessionId) {
          // Hand off to the card form; it tokenizes and POSTs to
          // /api/membership/subscribe with the token intent.
          setCardConfig(cfg);
          return;
        }
      }

      // Card entry unavailable (no processor, misconfig, 503). Fall back to the
      // pre-existing behaviour rather than dead-ending the shopper.
      const response = await fetch("/api/membership/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, billingCycle, agreedToTerms }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setMessage(data.error ?? "Unable to start your membership right now.");
        return;
      }
      // Card payments live: go to secure checkout. Perks activate the moment the
      // payment clears (the webhook turns on the membership), and the customer
      // lands on the order confirmation.
      if (data.checkoutUrl) {
        window.location.assign(data.checkoutUrl as string);
        return;
      }
      // Fallback (no processor connected): the request is saved, not charged.
      setStatus("success");
      setMessage(
        data.chargeSucceeded
          ? "Your membership is active."
          : "Your membership request is saved. Card payments aren't connected yet, so no charge was made — we'll follow up, or contact support to activate.",
      );
    } catch {
      setMessage("Unable to start your membership right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (cardConfig) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-white">
        <p className="vl2-eyebrow">Membership</p>
        <h1 className="vl2-serif mt-3 text-3xl">Payment details</h1>
        <p className="mt-3 text-sm text-white/70">
          {cardConfig.tierName} &middot; {money(cardConfig.amountCents)}
          {cardConfig.billingCycle === "annual" ? " per year" : " per month"}
        </p>

        <div className="mt-8">
          <MembershipCardForm
            tierId={tier.id}
            config={cardConfig}
            onSuccess={() => {
              setCardConfig(null);
              setStatus("success");
              setMessage("Your membership is active.");
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => { setCardConfig(null); setMessage(null); }}
          className="mt-6 text-xs text-white/50 underline"
        >
          Back
        </button>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="mx-auto max-w-xl px-6 py-32 text-center text-white">
        <p className="vl2-eyebrow">Membership</p>
        <h1 className="vl2-serif mt-3 text-3xl">You&apos;re in.</h1>
        <p className="mt-4 text-white/70">{message}</p>
        <button type="button" onClick={() => router.push("/account")} className="vl2-btn-primary vl-focus-ring mt-8 px-6 py-3 text-sm">
          Go to your dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-white">
      <p className="vl2-eyebrow">Join {tier.name}</p>
      <h1 className="vl2-serif mt-3 text-3xl">Confirm your membership</h1>

      <div className="mt-8 flex gap-2">
        <button type="button" onClick={() => { setBillingCycle("annual"); setAgreedToTerms(false); }} className={`flex-1 rounded-full border px-4 py-2.5 text-sm min-h-[44px] ${billingCycle === "annual" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}>
          Annual
        </button>
        <button type="button" onClick={() => { setBillingCycle("monthly"); setAgreedToTerms(false); }} className={`flex-1 rounded-full border px-4 py-2.5 text-sm min-h-[44px] ${billingCycle === "monthly" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}>
          Monthly
        </button>
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-white/50">Billing terms</p>

        {billingCycle === "annual" ? (
          <>
            <p className="mt-4 text-sm leading-6 text-white/80">
              One payment of <strong className="text-white">{money(tier.annualPriceCents)}</strong> for a full year,
              billed to your card.
            </p>
            <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200/90">
              The annual plan is <strong>non-refundable</strong>. Your perks activate as soon as your payment is
              confirmed, and stay active for the full year. It does not auto-renew.
            </p>
          </>
        ) : usesIntroOffer ? (
          <ul className="mt-4 space-y-3 text-sm leading-6 text-white/80">
            <li><strong className="text-white">{money(tier.introPriceCents)} today</strong> for your {tier.introDurationDays}-day intro period.</li>
            <li>Then the remaining first-month balance, then <strong className="text-white">{money(monthlyPrice)}/month</strong> until canceled.</li>
          </ul>
        ) : (
          <>
            <p className="mt-4 text-sm leading-6 text-white/80">
              <strong className="text-white">{money(monthlyPrice)}/month</strong>, billed to your card automatically until you cancel.
            </p>
            <p className="mt-2 text-xs text-white/50">Join today · cancel anytime · benefits start immediately. No hidden fees.</p>
          </>
        )}
      </div>

      <div className="mt-6">
        <MembershipPaymentMethodPlaceholder />
      </div>

      <label className="mt-6 flex items-start gap-3 rounded-2xl border border-white/10 p-4 text-sm text-white/70">
        <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} className="mt-1 h-4 w-4 border-white/25 bg-black/40" />
        <span>
          {billingCycle === "annual"
            ? "I understand this is a one-time, non-refundable annual payment, and my perks activate once payment is confirmed."
            : "I agree to recurring monthly card billing until I cancel. Membership charges are non-refundable."}
        </span>
      </label>

      {message ? <p className="mt-4 text-sm text-rose-300">{message}</p> : null}

      <button
        type="button"
        onClick={startMembership}
        disabled={!agreedToTerms || isSubmitting}
        className="vl2-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? "Starting your membership..." : billingCycle === "annual" ? "Confirm annual membership" : "Confirm membership"}
      </button>
    </div>
  );
}
