"use client";

import { useCallback, useState } from "react";

import type { SpinCampaignResults } from "@/lib/spin/spin-results";

// ---------------------------------------------------------------------------
// THE WHEEL, IN THE MARKETING SCREEN THE OWNER ALREADY USES.
//
// Two controls and three tables. Deliberately not a campaign builder: the
// prize table lives in code (lib/spin/prize-table.ts) and is shown here
// read-only, because a stored offer records the REWARD rather than the wedge,
// and that is what keeps an already-awarded prize meaning the same thing after
// the wheel is edited. Moving prizes into the database is a real feature with
// a real migration; pretending this screen is one would be worse than saying
// plainly that it is not.
//
// WHY THE KILL SWITCH IS THE FIRST THING ON THE PAGE. With `enabled` false the
// page 404s, the endpoint 404s, and — the part that is easy to miss —
// attachSpinLink returns the email's destination UNCHANGED, so a campaign sent
// while the wheel is off lands every recipient on a 404. Turning it on is a
// send-day step, not a setup step, and it is stated here in those words.
// ---------------------------------------------------------------------------

export type WheelPanelProps = {
  enabled: boolean;
  campaignId: string;
  results: SpinCampaignResults;
  knownCampaignIds: string[];
  /** Live dose stock for each prize's product, by slug. Absent = untracked. */
  stockBySlug: Record<string, number | null>;
  /** Prize rows straight from the table, so the screen cannot drift from it. */
  prizes: Array<{ id: string; label: string; wedgeLabel: string; minSubtotalCents: number; rewardKind: string; productSlug: string | null; percent: number | null; maxDiscountCents: number | null }>;
  ttlDays: number;
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function AdminWheelPanel(props: WheelPanelProps) {
  const [enabled, setEnabled] = useState(props.enabled);
  const [campaignId, setCampaignId] = useState(props.campaignId);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (updates: Array<{ key: string; value: unknown }>) => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: updates.map((u) => ({ section: "spin_wheel", key: u.key, value: u.value })) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        throw new Error(String(body?.error ?? `Save failed (${res.status})`));
      }
      setMessage("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      // Put the switch back where it was: a toggle that stays flipped after a
      // failed write is how a wheel gets believed to be off while it is on.
      setEnabled(props.enabled);
    } finally {
      setSaving(false);
    }
  }, [props.enabled]);

  const r = props.results;

  return (
    <section className="vl-panel rounded-[1.8rem] p-5 sm:p-6" data-testid="admin-wheel-panel">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Spin the wheel</h2>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${
            enabled ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.06] text-white/50"
          }`}
          data-testid="wheel-state"
        >
          {enabled ? "Live" : "Off"}
        </span>
      </header>

      {!enabled ? (
        <p className="mb-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100/80">
          While this is off, <code className="text-amber-200">/spin</code> returns 404 <em>and</em> the invitation
          email&apos;s button stops being personalised — every recipient would land on a dead page. Turn it on
          before the campaign sends, not after.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => {
              const next = e.target.checked;
              setEnabled(next);
              void save([{ key: "enabled", value: next }]);
            }}
            className="mt-0.5 h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]"
            data-testid="wheel-enabled"
          />
          <span className="text-sm text-white/70">
            Wheel is live
            <span className="mt-1 block text-[11px] leading-relaxed text-white/40">
              Off by default, and off is the only state that cannot mint a prize.
            </span>
          </span>
        </label>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
          <label className="block text-sm text-white/70" htmlFor="wheel-campaign-id">
            Campaign id
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="wheel-campaign-id"
              value={campaignId}
              disabled={saving}
              onChange={(e) => setCampaignId(e.target.value)}
              className="vl-input w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-white"
              data-testid="wheel-campaign-id"
            />
            <button
              type="button"
              disabled={saving || campaignId.trim() === props.campaignId}
              onClick={() => void save([{ key: "campaignId", value: campaignId.trim() }])}
              className="vl-ghost rounded-lg border border-white/12 px-3 text-xs font-semibold text-white/80 disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            This scopes one spin per customer. Changing it starts a <strong>new</strong> promotion: everyone who
            span under the old id may spin again, and old links stop working. It is not a label.
          </p>
        </div>
      </div>

      {message ? <p className="mt-3 text-xs text-emerald-300">{message}</p> : null}
      {error ? <p className="mt-3 text-xs text-rose-300" data-testid="wheel-error">{error}</p> : null}

      {/* ---------------------------------------------------------------- */}
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">
        Results — {r.campaignId}
      </h3>
      {r.degraded ? (
        <p className="mt-2 text-xs text-rose-300">Could not read results. The figures below are not real.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-6">
          {[
            ["Spins", r.spins],
            ["Redeemed", r.redeemed],
            ["Live", r.live],
            ["Expired", r.expired],
            ["Held", r.reserved],
            ["Revoked", r.revoked],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
              <div className="text-lg font-semibold text-white">{String(value)}</div>
              <div className="text-[11px] uppercase tracking-wider text-white/40">{String(label)}</div>
            </div>
          ))}
        </div>
      )}
      {r.redemptionRatePercent !== null ? (
        <p className="mt-2 text-[11px] text-white/45">
          {r.redemptionRatePercent}% of prizes awarded have been redeemed on a paid order.
        </p>
      ) : null}

      {props.knownCampaignIds.length > 1 ? (
        <p className="mt-2 text-[11px] text-white/35">
          Other campaigns with prizes on record: {props.knownCampaignIds.filter((id) => id !== r.campaignId).join(", ")}
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      <h3 className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-white/45">
        The wheel — {props.prizes.length} wedges, prizes expire after {props.ttlDays * 24} hours
      </h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-white/40">
              <th className="pb-2 pr-3 font-medium">Prize</th>
              <th className="pb-2 pr-3 font-medium">Odds</th>
              <th className="pb-2 pr-3 font-medium">Qualifying order</th>
              <th className="pb-2 pr-3 font-medium">Cap</th>
              <th className="pb-2 pr-3 font-medium">Stock</th>
              <th className="pb-2 pr-3 font-medium">Awarded</th>
              <th className="pb-2 font-medium">Redeemed</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            {r.byPrize.length > 0
              ? r.byPrize.map((prize) => {
                  const source = props.prizes.find((p) => p.id === prize.id);
                  const slug = source?.productSlug ?? null;
                  const stock = slug ? props.stockBySlug[slug] : undefined;
                  // Five units of Tesamorelin is the one prize a campaign can
                  // genuinely exhaust, so thin stock is called out rather than
                  // printed as a number among numbers.
                  const thin = typeof stock === "number" && stock > 0 && stock <= 10;
                  return (
                    <tr key={prize.id} className="border-t border-white/[0.06]">
                      <td className="py-2 pr-3">{prize.label}</td>
                      <td className="py-2 pr-3 tabular-nums text-white/50">{prize.wedges} in {props.prizes.length}</td>
                      <td className="py-2 pr-3 tabular-nums">
                        {prize.minSubtotalCents > 0 ? money(prize.minSubtotalCents) : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums text-white/50">
                        {source?.maxDiscountCents ? money(source.maxDiscountCents) : "—"}
                      </td>
                      <td className={`py-2 pr-3 tabular-nums ${thin ? "text-amber-300" : "text-white/50"}`}>
                        {stock === null ? "untracked" : typeof stock === "number" ? stock : "—"}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{prize.awarded}</td>
                      <td className="py-2 tabular-nums">{prize.redeemed}</td>
                    </tr>
                  );
                })
              : (
                <tr>
                  <td colSpan={7} className="py-3 text-white/40">No prizes awarded under this campaign id yet.</td>
                </tr>
              )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-white/35">
        Prizes are defined in <code>src/lib/spin/prize-table.ts</code> and shown here read-only. A stored prize
        records the reward rather than the wedge, so editing the wheel never changes what an already-awarded
        prize means — which is also why editing it needs a deploy rather than a form.
        To send it: compose a campaign in the composer above with its CTA path set to{" "}
        <code>/spin</code>, and the button becomes each recipient&apos;s own wheel link at click time.
      </p>
    </section>
  );
}
