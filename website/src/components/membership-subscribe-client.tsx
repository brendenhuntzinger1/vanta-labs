"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MembershipTier } from "@/lib/membership";
import { MembershipPaymentMethodPlaceholder } from "@/components/membership-payment-method";
import { ManualPaymentInstructions } from "@/components/manual-payment-instructions";
import { getEnabledPaymentMethods, getPaymentMethodById, isManualPaymentMethod, type PaymentMethodConfig } from "@/lib/payment-methods";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

const CARD_FEE_RATE = 0.05;

type CreatedAnnual = { orderId: string; orderNumber: string; amount: number; method: PaymentMethodConfig };

export function MembershipSubscribeClient({ tier }: { tier: MembershipTier }) {
  const router = useRouter();
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("annual");
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "success">("idle");

  // Manual methods (Cash App / Zelle / PayPal) for the one-time annual payment.
  const [manualMethods, setManualMethods] = useState<PaymentMethodConfig[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [createdAnnual, setCreatedAnnual] = useState<CreatedAnnual | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/catalog/payment-methods", { cache: "no-store" });
        const data = await res.json() as { success: boolean; methods?: PaymentMethodConfig[] };
        if (data.success && Array.isArray(data.methods)) {
          const manual = getEnabledPaymentMethods(data.methods).filter(isManualPaymentMethod);
          setManualMethods(manual);
          setSelectedMethodId((cur) => cur || manual[0]?.id || "");
        }
      } catch {
        /* picker just won't show until this loads */
      }
    })();
  }, []);

  const usesIntroOffer = billingCycle === "monthly" && tier.introOfferEnabled;
  const monthlyWithFee = Math.round(tier.monthlyPriceCents * (1 + CARD_FEE_RATE));

  // Monthly = recurring card billing (existing flow).
  const handleMonthly = async () => {
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
        body: JSON.stringify({ tierId: tier.id, billingCycle: "monthly", agreedToTerms }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setMessage(data.error ?? "Unable to start your membership right now.");
        return;
      }
      setStatus("success");
      setMessage(
        data.chargeSucceeded
          ? "Your membership is active."
          : "Your membership request is saved. Card billing isn't connected yet, so no charge was made — we'll follow up, or contact support to activate.",
      );
    } catch {
      setMessage("Unable to start your membership right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Annual = one-time manual payment (no fee, non-refundable).
  const handleAnnual = async () => {
    if (!agreedToTerms) {
      setMessage("Please agree to the annual (non-refundable) terms to continue.");
      return;
    }
    if (!selectedMethodId) {
      setMessage("Choose Cash App, Zelle, or PayPal.");
      return;
    }
    setIsSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/membership/annual-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId: tier.id, paymentMethod: selectedMethodId }),
      });
      const data = await response.json() as { success: boolean; error?: string; orderId?: string; orderNumber?: string; amount?: number; paymentMethod?: string };
      if (!response.ok || !data.success || !data.orderId) {
        setMessage(data.error ?? "Unable to start your membership right now.");
        return;
      }
      const method = getPaymentMethodById(manualMethods, data.paymentMethod) ?? manualMethods.find((m) => m.id === selectedMethodId);
      if (!method) {
        setMessage("Payment method unavailable. Please try again.");
        return;
      }
      setCreatedAnnual({ orderId: data.orderId, orderNumber: data.orderNumber ?? "", amount: Number(data.amount ?? 0), method });
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setMessage("Unable to start your membership right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Annual: after order creation, show the manual payment panel.
  if (createdAnnual) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-24 text-white">
        <p className="vl2-eyebrow">Annual {tier.name} Membership</p>
        <h1 className="vl2-serif mt-3 text-3xl">Send your payment</h1>
        <p className="mt-3 text-sm text-white/60">Your membership activates as soon as we verify your payment. This is a one-time, non-refundable annual payment.</p>
        <div className="mt-7">
          <ManualPaymentInstructions
            method={createdAnnual.method}
            orderId={createdAnnual.orderId}
            orderNumber={createdAnnual.orderNumber}
            amountDue={createdAnnual.amount}
          />
        </div>
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
        <button type="button" onClick={() => { setBillingCycle("annual"); setAgreedToTerms(false); }} className={`flex-1 rounded-full border px-4 py-2 text-sm ${billingCycle === "annual" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}>
          Annual · no fee
        </button>
        <button type="button" onClick={() => { setBillingCycle("monthly"); setAgreedToTerms(false); }} className={`flex-1 rounded-full border px-4 py-2 text-sm ${billingCycle === "monthly" ? "border-white bg-white text-black" : "border-white/20 text-white/70"}`}>
          Monthly
        </button>
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-white/50">Billing terms</p>

        {billingCycle === "annual" ? (
          <>
            <p className="mt-4 text-sm leading-6 text-white/80">
              One payment of <strong className="text-white">{money(tier.annualPriceCents)}</strong> for a full year. Pay
              directly with Cash App, Zelle, or PayPal — <strong className="text-white">no processing fee</strong>.
            </p>
            <p className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200/90">
              The annual plan is <strong>non-refundable</strong>. Your perks activate as soon as we verify your payment,
              and stay active for the full year. It does not auto-renew.
            </p>

            <p className="mt-5 text-xs uppercase tracking-[0.14em] text-white/50">Pay with</p>
            <div className="mt-2 grid gap-2">
              {manualMethods.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMethodId(m.id)}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm ${selectedMethodId === m.id ? "border-[color:var(--accent-gold)] bg-[color:var(--accent-gold-soft)]" : "border-white/15 hover:border-white/30"}`}
                >
                  <span className="text-lg" aria-hidden>{m.icon}</span>
                  <span className="font-semibold text-white">{m.label}</span>
                  <span className="ml-auto text-xs text-emerald-300">No fee</span>
                </button>
              ))}
            </div>
          </>
        ) : usesIntroOffer ? (
          <ul className="mt-4 space-y-3 text-sm leading-6 text-white/80">
            <li><strong className="text-white">{money(tier.introPriceCents)} today</strong> for your {tier.introDurationDays}-day intro period.</li>
            <li>Then the remaining first-month balance, then <strong className="text-white">{money(monthlyWithFee)}/month</strong> until canceled.</li>
            <li className="text-amber-200/90">Monthly plans are billed to a card and include a 5% card processing fee.</li>
          </ul>
        ) : (
          <>
            <p className="mt-4 text-sm leading-6 text-white/80">
              <strong className="text-white">{money(monthlyWithFee)}/month</strong> (includes 5% card processing fee),
              billed to your card automatically until you cancel.
            </p>
            <p className="mt-3 text-xs leading-5 text-white/45">
              Monthly is a recurring card payment, so the 5% fee applies. Prefer no fee? Choose the annual plan and pay
              with Cash App, Zelle, or PayPal.
            </p>
          </>
        )}
      </div>

      {billingCycle === "monthly" ? (
        <div className="mt-6">
          <MembershipPaymentMethodPlaceholder />
        </div>
      ) : null}

      <label className="mt-6 flex items-start gap-3 rounded-2xl border border-white/10 p-4 text-sm text-white/70">
        <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)} className="mt-1 h-4 w-4 border-white/25 bg-black/40" />
        <span>
          {billingCycle === "annual"
            ? "I understand this is a one-time, non-refundable annual payment, and my perks activate once payment is verified."
            : "I agree to recurring monthly card billing (including the 5% processing fee) until I cancel. Membership charges are non-refundable."}
        </span>
      </label>

      {message ? <p className="mt-4 text-sm text-rose-300">{message}</p> : null}

      <button
        type="button"
        onClick={billingCycle === "annual" ? handleAnnual : handleMonthly}
        disabled={!agreedToTerms || isSubmitting}
        className="vl2-btn-primary vl-focus-ring mt-6 w-full px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? "Starting your membership..." : billingCycle === "annual" ? "Continue to payment" : "Confirm membership"}
      </button>
    </div>
  );
}
