"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// ---------------------------------------------------------------------------
// TWO RATES, EDITED SEPARATELY, SAVED SEPARATELY.
//
//   Customer discount  what the SHOPPER saves at checkout using the code
//   Commission         what the AMBASSADOR earns on the sale
//
// They answer to different people, so each has its own field, its own Save, and
// its own request. Nothing here reads one value to compute the other -- the two
// forms do not share state, which is what makes the independence structural
// rather than a promise.
//
// The discount field distinguishes empty from zero. Empty clears the override
// and returns the ambassador to the program default; 0 is a real, deliberate
// rate for a code that tracks attribution without discounting.
// ---------------------------------------------------------------------------

type Props = {
  partnerId: string;
  status: string;
  commissionPercent: number;
  commissionPercentLocked: boolean;
  customerDiscountPercent: number | null;
  programDefaultDiscountPercent: number;
};

export default function AdminAmbassadorRatesCard({
  partnerId,
  status,
  commissionPercent,
  commissionPercentLocked,
  customerDiscountPercent,
  programDefaultDiscountPercent,
}: Props) {
  const router = useRouter();
  const [discount, setDiscount] = useState(customerDiscountPercent == null ? "" : String(customerDiscountPercent));
  const [commission, setCommission] = useState(String(commissionPercent));
  const [busy, setBusy] = useState<"discount" | "commission" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function save(which: "discount" | "commission", body: Record<string, unknown>) {
    setBusy(which);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/partners/${partnerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The status must ride along unchanged: set_status is the update action,
        // and omitting it would reject the request rather than preserve it.
        body: JSON.stringify({ action: "set_status", status, ...body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success === false) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "Save failed.");
      }
      setMessage({ tone: "ok", text: which === "discount" ? "Customer discount saved." : "Commission rate saved." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Save failed." });
    } finally {
      setBusy(null);
    }
  }

  const trimmedDiscount = discount.trim();
  const inheriting = trimmedDiscount === "";

  return (
    <section className="vl-panel rounded-2xl p-4 sm:p-5">
      <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Rates</h2>
      <p className="mt-1 text-xs text-zinc-500">
        These two numbers are independent. Changing one never changes the other.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Customer Discount</p>
          <p className="mt-1 text-xs text-zinc-500">What shoppers save using this code.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              max={99.99}
              step={0.5}
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              placeholder={`${programDefaultDiscountPercent} (program default)`}
              className="vl-input w-32 px-3 py-2 text-sm"
              aria-label="Customer discount percent"
            />
            <span className="text-sm text-zinc-400">%</span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => save("discount", { customerDiscountPercent: inheriting ? null : Number(trimmedDiscount) })}
              className="vl-focus-ring rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-50"
            >
              {busy === "discount" ? "Saving…" : "Save Discount"}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {inheriting
              ? `Inheriting the program default (${programDefaultDiscountPercent}%). Leave empty to keep following it.`
              : "Overriding the program default for this ambassador only."}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Commission</p>
          <p className="mt-1 text-xs text-zinc-500">What this ambassador earns per sale.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={commission}
              onChange={(event) => setCommission(event.target.value)}
              className="vl-input w-32 px-3 py-2 text-sm"
              aria-label="Commission percent"
            />
            <span className="text-sm text-zinc-400">%</span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => save("commission", { commissionPercent: Number(commission) })}
              className="vl-focus-ring rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-100 disabled:opacity-50"
            >
              {busy === "commission" ? "Saving…" : "Save Commission"}
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {commissionPercentLocked
              ? "Manual rate — automatic performance tiers are off for this ambassador."
              : "Automatic performance tiers are active. Saving a rate here switches to manual."}
          </p>
        </div>
      </div>

      {message ? (
        <p className={`mt-3 text-sm ${message.tone === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>
      ) : null}

      <p className="mt-3 text-xs text-zinc-500">
        Rate changes apply to future orders only. Past orders keep the discount and commission that were recorded when
        they were placed.
      </p>
    </section>
  );
}
