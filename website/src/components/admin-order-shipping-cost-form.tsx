"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// ENTER THE POSTAGE SHIPPO CANNOT REPORT.
//
// The shipping-cost repair sweep re-fetches settled postage from Shippo, and
// for almost every label that is the only source anyone should trust. But a
// label adopted from the Shippo dashboard can carry a bare rate reference with
// no readable amount, and for those the sweep gives up by design:
//
//   shipping_cost_manual_entry_required — "N order(s) have a label whose
//   postage cannot be read back from Shippo. Enter the cost by hand in
//   Admin -> Orders; no automatic repair is possible."
//
// `set_shipping_cost` on PATCH /api/admin/orders/[orderId] has always been able
// to record it -- role-gated to profit viewers, bounded, and audited twice over
// -- but nothing ever called it, so that instruction pointed at a control that
// did not exist. This is that control.
//
// It is offered ONLY where the exact cost is still unknown (see the caller in
// admin-order-profit-panel). That restriction is the point: the form used to
// sit on every order, which let a typed figure quietly outrank a measured one.
// Shippo remains the only source for postage it can actually report.
// ---------------------------------------------------------------------------

/**
 * The largest entry the server will take.
 *
 * Mirrored from the route rather than imported, because that module is
 * server-only. Kept identical on purpose: a client that accepts more just
 * spends a round trip to be told no. `parseShippingCostInput` is tested
 * against this exact boundary.
 */
const MAX_SHIPPING_COST_DOLLARS = 10000;

export type ParsedShippingCost =
  | { ok: true; amount: number }
  | { ok: false; error: string };

/**
 * Read what the operator typed as a dollar figure.
 *
 * Accepts what a person copying a figure off a label actually types -- a
 * leading $, thousands separators -- and refuses everything the server would
 * refuse, in the same terms, so the failure is immediate rather than a 400.
 *
 * ZERO IS A VALID ENTRY. A free or fully-discounted label really did cost
 * nothing, and `!amount` would reject it while looking like an emptiness check.
 */
export function parseShippingCostInput(raw: string): ParsedShippingCost {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter the postage amount from the label." };
  }

  const amount = Number(trimmed.replace(/[$,]/g, ""));
  if (!Number.isFinite(amount)) {
    return { ok: false, error: "That is not an amount. Enter a figure like 7.42." };
  }
  if (amount < 0) {
    return { ok: false, error: "Postage cannot be negative." };
  }
  if (amount > MAX_SHIPPING_COST_DOLLARS) {
    return { ok: false, error: `Enter a shipping cost between $0 and $${MAX_SHIPPING_COST_DOLLARS.toLocaleString()}.` };
  }

  return { ok: true, amount };
}

/**
 * Is this the one refusal a human is allowed to overrule?
 *
 * recordActualShippingCost refuses to cost a voided label, so no automated
 * caller can re-charge postage the carrier refunded. A person who knows the
 * carrier DECLINED that refund may say so -- and only then. Matching on the
 * flag name rather than the prose keeps this tied to the thing the server
 * actually reads.
 */
export function isVoidedLabelRefusal(error: string): boolean {
  return error.includes("overrideVoidedLabel");
}

export function AdminOrderShippingCostForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Revealed by the server's refusal, never rendered up front.
   *
   * A permanently-visible "charge it anyway" checkbox is one absent-minded
   * tick away from booking refunded postage as a cost, on an order where the
   * guard was working correctly.
   */
  const [overrideOffered, setOverrideOffered] = useState(false);
  const [override, setOverride] = useState(false);

  const submit = async () => {
    const parsed = parseShippingCostInput(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_shipping_cost",
          shippingCostAmount: parsed.amount,
          ...(override ? { overrideVoidedLabel: true } : {}),
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };

      if (!json.success) {
        const message = json.error ?? "Unable to record shipping cost.";
        setError(message);
        // Only widen the form when the server says this is the refusal that
        // has a human override. Every other failure is just a failure.
        if (isVoidedLabelRefusal(message)) setOverrideOffered(true);
        return;
      }

      // The panel is server-rendered from the order row, and recording the cost
      // finalizes the profit figures above it. Refresh so the whole panel
      // reflects the new state rather than just this form.
      setValue("");
      setOverrideOffered(false);
      setOverride(false);
      router.refresh();
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Unable to record shipping cost.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <label htmlFor="exact-shipping-cost" className="block text-[11px] uppercase tracking-[0.14em] text-zinc-400">
        Exact shipping cost
      </label>
      <p className="mt-1 text-[11px] text-zinc-500">
        Shippo cannot report the postage for this label. Enter the amount you were charged and the profit
        figures above will finalize.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-white/15 bg-black/30 px-2">
          <span className="text-sm text-zinc-500">$</span>
          <input
            id="exact-shipping-cost"
            name="exact-shipping-cost"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="7.42"
            value={value}
            disabled={saving}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            className="w-28 bg-transparent px-1 py-1.5 text-sm tabular-nums text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={saving}
          className="rounded-lg border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-white/[0.1] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Record cost"}
        </button>
      </div>

      {overrideOffered ? (
        <label className="mt-2 flex items-start gap-2 text-[11px] text-amber-300/90">
          <input
            type="checkbox"
            checked={override}
            disabled={saving}
            onChange={(event) => setOverride(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            The carrier declined the refund for this voided label and the postage was really paid. Record it
            anyway.
          </span>
        </label>
      ) : null}

      {error ? <p className="mt-2 text-[11px] text-rose-300">{error}</p> : null}
    </div>
  );
}
