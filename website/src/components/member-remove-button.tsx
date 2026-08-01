"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Remove-member control for the admin membership roster.
 *
 * Removing a member stops all future billing but LETS THEM KEEP every benefit
 * they already paid for through the end of the current period — the API calls
 * cancelMembership(), which sets cancel_at_period_end so no renewal charge fires
 * and the scheduled sweep flips them to the free tier only once that paid period
 * actually ends. A member still inside the $1 trial is ended immediately so the
 * first-month remainder charge never fires.
 *
 * The action is guarded behind an inline "Are you sure you want to remove them?"
 * confirmation so a stray click can't drop a paying member.
 */
export function MemberRemoveButton({
  userId,
  name,
  status,
  cancelAtPeriodEnd,
  billingCycle,
}: {
  userId: string;
  name: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  billingCycle: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already removed (cancelling at period end) or on a free tier with nothing to
  // bill — there is nothing left to remove.
  const alreadyRemoved = cancelAtPeriodEnd || status === "cancelled";
  const isFree = billingCycle === "free";

  if (alreadyRemoved) {
    return <span className="text-xs text-zinc-500">Removed · ending</span>;
  }

  if (isFree) {
    return <span className="text-xs text-zinc-600">—</span>;
  }

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/membership/customers/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove" }),
      });
      const result = (await response.json()) as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to remove this member.");
        setBusy(false);
        return;
      }
      setConfirming(false);
      setBusy(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-zinc-300">
          Are you sure you want to remove <span className="font-medium text-white">{name}</span>? They keep the
          benefits they paid for until the end of this period, and won&apos;t be charged again.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRemove}
            disabled={busy}
            className="rounded-full bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? "Removing…" : "Yes, remove"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            disabled={busy}
            className="rounded-full border border-white/15 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-white/30 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        {error ? <p className="text-xs text-red-300">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-full border border-red-400/30 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:border-red-400/60 hover:text-red-200"
      >
        Remove member
      </button>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
    </div>
  );
}
