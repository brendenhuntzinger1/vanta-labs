"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MembershipTier } from "@/lib/membership";
import { MembershipPaymentMethodPlaceholder } from "@/components/membership-payment-method";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function MembershipSubscribeClient({ tier }: { tier: MembershipTier }) {
  const router = useRouter();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "success">("idle");

  const usesIntroOffer = billingCycle === "monthly" && tier.introOfferEnabled;
  const remainderCents = Math.max(0, tier.monthlyPriceCents - tier.introPriceCents);

  const handleSubmit = async () => {
    if (!agreedToTerms) {
      setMessage("Please agree to the recurring billing terms to continue.");
      return;
    }

    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/membership/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, billingCycle, agreedToTerms }),
      });
      const data = await response.json();

      if (!response.ok || !data.success) {
        setMessage(data.error ?? "Unable to start your membership right now.");
        setIsSubmitting(false);
        return;
      }

      setStatus("success");
      setMessage(
        data.chargeSucceeded
          ? "Your membership is active."
          : "Your membership request has been saved. Billing isn't connected yet, so no charge could be attempted - Vanta Labs will follow up once it is, or you can contact support to activate manually.",
      );
    } catch {
      setMessage("Unable to start your membership right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (status === "success") {
    return (
      <div className="mx-auto max-w-xl px-6 py-32 text-center text-white">
        <p className="vl2-eyebrow">Membership</p>
        <h1 className="vl2-serif mt-3 text-3xl">You&apos;re in.</h1>
        <p className="mt-4 text-white/70">{message}</p>
        <button
          type="button"
          onClick={() => router.push("/account")}
          className="vl2-btn-primary vl-focus-ring mt-8 px-6 py-3 text-sm"
        >
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
        <button
          type="button"
          onClick={() => setBillingCycle("monthly")}
          className={`flex-1 rounded-full border px-4 py-2 text-sm ${billingCycle === "monthly" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setBillingCycle("annual")}
          className={`flex-1 rounded-full border px-4 py-2 text-sm ${billingCycle === "annual" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}
        >
          Annual
        </button>
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-white/50">Billing terms</p>
        {usesIntroOffer ? (
          <ul className="mt-4 space-y-3 text-sm leading-6 text-white/80">
            <li>
              <strong className="text-white">{money(tier.introPriceCents)} today</strong> for your {tier.introDurationDays}-day
              introductory period.
            </li>
            <li>
              After {tier.introDurationDays} days, you&apos;ll be charged the remaining balance of your first month&apos;s
              membership (<strong className="text-white">{money(remainderCents)}</strong>).
            </li>
            <li>
              After that, your membership renews automatically at{" "}
              <strong className="text-white">{money(tier.monthlyPriceCents)} per month</strong> until canceled.
            </li>
          </ul>
        ) : (
          <p className="mt-4 text-sm leading-6 text-white/80">
            You&apos;ll be charged{" "}
            <strong className="text-white">
              {money(billingCycle === "annual" ? tier.annualPriceCents : tier.monthlyPriceCents)}
            </strong>{" "}
            today, then automatically every {billingCycle === "annual" ? "year" : "month"} until you cancel.
          </p>
        )}
      </div>

      <div className="mt-6">
        <MembershipPaymentMethodPlaceholder />
      </div>

      <label className="mt-6 flex items-start gap-3 rounded-2xl border border-white/10 p-4 text-sm text-white/70">
        <input
          type="checkbox"
          checked={agreedToTerms}
          onChange={(event) => setAgreedToTerms(event.target.checked)}
          className="mt-1 h-4 w-4 border-white/25 bg-black/40"
        />
        <span>
          I agree to be charged as described above, and understand my membership renews automatically until I cancel.
        </span>
      </label>

      {message ? <p className="mt-4 text-sm text-rose-300">{message}</p> : null}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!agreedToTerms || isSubmitting}
        className="vl2-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? "Starting your membership..." : "Confirm membership"}
      </button>
    </div>
  );
}
