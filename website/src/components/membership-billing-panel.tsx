"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CustomerMembership } from "@/lib/membership";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function introCountdown(introEndsAt: string) {
  const msRemaining = new Date(introEndsAt).getTime() - Date.now();
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
  return daysRemaining;
}

export function MembershipBillingPanel({ membership }: { membership: CustomerMembership }) {
  const router = useRouter();
  const [isCanceling, setIsCanceling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (membership.billingCycle === "free") {
    return null;
  }

  const handleCancel = async () => {
    if (!window.confirm("Cancel your membership? You'll keep access until your next renewal date.")) {
      return;
    }

    setIsCanceling(true);
    setMessage(null);

    try {
      const response = await fetch("/api/membership/cancel", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.success) {
        setMessage(data.error ?? "Unable to cancel right now.");
        return;
      }
      setMessage("Your membership will end at your next renewal date.");
      router.refresh();
    } catch {
      setMessage("Unable to cancel right now.");
    } finally {
      setIsCanceling(false);
    }
  };

  return (
    <div className="mt-5 vl-panel-soft rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Billing</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {membership.introStatus === "active" && membership.introEndsAt ? (
          <div>
            <p className="text-xs text-zinc-500">Intro period</p>
            <p className="mt-1 text-sm text-white">{introCountdown(membership.introEndsAt)} day(s) remaining</p>
          </div>
        ) : null}

        {membership.nextBillingAt ? (
          <div>
            <p className="text-xs text-zinc-500">Next billing date</p>
            <p className="mt-1 text-sm text-white">{formatDate(membership.nextBillingAt)}</p>
          </div>
        ) : null}

        {membership.nextBillingAmountCents !== null ? (
          <div>
            <p className="text-xs text-zinc-500">Next billing amount</p>
            <p className="mt-1 text-sm text-white">{money(membership.nextBillingAmountCents)}</p>
          </div>
        ) : null}

        <div>
          <p className="text-xs text-zinc-500">Payment method</p>
          <p className="mt-1 text-sm text-white">{membership.hasPaymentMethod ? "On file" : "Not connected yet"}</p>
        </div>
      </div>

      {membership.cancelAtPeriodEnd ? (
        <p className="mt-4 text-xs text-amber-400">Your membership is set to cancel at the end of your current period.</p>
      ) : membership.status === "cancelled" ? null : (
        <button
          type="button"
          onClick={handleCancel}
          disabled={isCanceling}
          className="mt-4 text-xs text-zinc-400 underline underline-offset-4 hover:text-white disabled:opacity-50"
        >
          {isCanceling ? "Canceling..." : "Cancel membership"}
        </button>
      )}

      {message ? <p className="mt-3 text-xs text-zinc-400">{message}</p> : null}
    </div>
  );
}
