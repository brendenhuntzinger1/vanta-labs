"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Membership = {
  status: string;
  billingCycle: string;
  cancelAtPeriodEnd: boolean;
  /**
   * K-07. One skip per paid period. Derived on the server by
   * skipUsedThisPaidPeriod — the same function skipNextBilling guards with — so
   * the button and the endpoint cannot disagree about the rule.
   */
  skipAlreadyUsed?: boolean;
};

type ActionKey = "pause" | "resume" | "skip";

const COPY: Record<ActionKey, { endpoint: string; confirm: string; cta: string; busy: string }> = {
  // A pause is ONE deferred cycle, not an open-ended stop: the processor has no
  // pause, so the next charge moves out one cycle and lands on that new date
  // whether or not the member has resumed by then (membership-billing.ts
  // pauseMembership). The copy used to promise "you won't be charged while
  // paused", which was false after that cycle, and "billing restarts from a
  // fresh cycle" on resume, which is not what happens either — the deferred
  // date stands. Both now say what the code does.
  pause: {
    endpoint: "/api/membership/pause",
    confirm: "Pause your membership? Your member benefits pause and your next charge moves forward one billing cycle. If you haven't resumed by then, billing continues on that date.",
    cta: "Pause membership",
    busy: "Pausing…",
  },
  resume: {
    endpoint: "/api/membership/resume",
    confirm: "Resume your membership? Benefits turn back on and billing continues on your next billing date.",
    cta: "Resume membership",
    busy: "Resuming…",
  },
  skip: {
    endpoint: "/api/membership/skip",
    confirm: "Skip your next charge? Your renewal date moves forward one cycle — you keep your benefits and won't be charged next time.",
    cta: "Skip next charge",
    busy: "Skipping…",
  },
};

/**
 * Pause / skip / resume controls for a monthly membership. Annual plans are a
 * one-time pass, so these never render for them. Each action confirms inline
 * before firing, then refreshes the server data.
 */
export function SubscriptionActions({ membership }: { membership: Membership }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<ActionKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isPaused = membership.status === "paused";
  // A PAUSED plan can always be resumed — including one that was then set to
  // cancel at period end. cancelMembership on a paused row leaves it paused
  // and only sets cancel_at_period_end, and the account page tells that member
  // "Resume any time"; requiring !cancelAtPeriodEnd here hid the only control
  // that instruction referred to. Resuming clears both the pause and the
  // wind-down (resumeMembership). Skip/Pause are still withheld from a plan
  // that is ending.
  const canManage =
    membership.billingCycle === "monthly" &&
    (isPaused || (membership.status === "active" && !membership.cancelAtPeriodEnd));

  if (!canManage) return null;

  // Offering Skip to someone who has already used it produces a confusing
  // failure at the moment they act. Show the state instead.
  const skipAvailable = !membership.skipAlreadyUsed;

  const run = async (action: ActionKey) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(COPY[action].endpoint, { method: "POST" });
      const result = (await response.json()) as { success: boolean; error?: string };
      if (!response.ok || !result.success) {
        setError(result.error ?? "Something went wrong. Please try again.");
        return;
      }
      setConfirming(null);
      setMessage(action === "pause" ? "Membership paused." : action === "resume" ? "Membership resumed." : "Your next charge is skipped.");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const actions: ActionKey[] = isPaused ? ["resume"] : skipAvailable ? ["skip", "pause"] : ["pause"];

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      {confirming ? (
        <div className="rounded-xl border border-white/12 bg-white/[0.02] p-4">
          <p className="text-sm text-zinc-300">{COPY[confirming].confirm}</p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => run(confirming)}
              disabled={busy}
              className="vl2-btn-primary vl-focus-ring inline-flex px-4 py-2 text-xs disabled:opacity-60"
            >
              {busy ? COPY[confirming].busy : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(null); setError(null); }}
              disabled={busy}
              className="vl-focus-ring rounded-full border border-white/15 px-4 py-2 text-xs text-zinc-300 transition hover:border-white/30 disabled:opacity-60"
            >
              Keep as is
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => { setConfirming(action); setMessage(null); }}
              className={`vl-focus-ring inline-flex rounded-full px-4 py-2 text-xs font-medium transition ${
                action === "resume"
                  ? "border border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20"
                  : "border border-white/15 bg-white/[0.03] text-zinc-200 hover:border-white/30"
              }`}
            >
              {COPY[action].cta}
            </button>
          ))}
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
      {message ? <p className="mt-2 text-xs text-emerald-300">{message}</p> : null}
      {isPaused ? <p className="mt-2 text-xs text-amber-200/80">Your membership is paused — benefits are off until you resume.</p> : null}
    </div>
  );
}
