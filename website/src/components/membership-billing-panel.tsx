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

  const isAnnual = membership.billingCycle === "annual";
  const accessUntilLabel = membership.nextBillingAt ? formatDate(membership.nextBillingAt) : "the end of your current term";

  const handleCancel = async () => {
    // Memberships are non-refundable for both cycles. Annual members keep
    // access for the remainder of the year they already paid for; monthly
    // members keep access to the end of the current month. Neither is refunded.
    const confirmText = isAnnual
      ? `Cancel your annual membership?\n\nAnnual memberships are non-refundable. You'll keep full access until ${accessUntilLabel}, and it will not renew. No refund is issued for the remaining time.`
      : `Cancel your membership?\n\nYou'll keep access until ${accessUntilLabel}, and it will not renew. Memberships are non-refundable.`;

    if (!window.confirm(confirmText)) {
      return;
    }

    setIsCanceling(true);
    setMessage(null);

    try {
      const response = await fetch("/api/membership/cancel", { method: "POST" });
      const data = await response.json() as { success: boolean; error?: string; accessUntil?: string | null; billingCycle?: string };
      if (!response.ok || !data.success) {
        setMessage(data.error ?? "Unable to cancel right now.");
        return;
      }
      const until = data.accessUntil ? formatDate(data.accessUntil) : accessUntilLabel;
      setMessage(
        data.billingCycle === "annual"
          ? `Your annual membership won't renew. You keep access until ${until} (non-refundable).`
          : `Your membership won't renew. You keep access until ${until}.`,
      );
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

      <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-5 text-zinc-500">
        {isAnnual
          ? "Annual memberships are non-refundable. You can cancel anytime to stop auto-renewal and keep access for the remainder of your paid year."
          : "You can cancel anytime to stop auto-renewal and keep access through your current month. Membership charges are non-refundable."}
      </p>
    </div>
  );
}
