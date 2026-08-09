"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Live campaign performance, when TikTok will give it to us.
 *
 * Three states, kept distinct because collapsing them is how a dashboard starts
 * lying: not connected (no credential), connected but rejected (TikTok's own
 * code and message, verbatim), and connected with rows — including zero rows,
 * which means no spend rather than no connection.
 */

type Row = {
  campaignId: string;
  campaignName: string;
  statDate: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
};

type Response = {
  connected: boolean;
  ok?: boolean;
  reason?: string;
  missing?: string[];
  code?: number | null;
  message?: string;
  requestId?: string | null;
  writesEnabled?: boolean;
  range?: { since: string; until: string };
  rows?: Row[];
};

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(2)}%`);
const dollars = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);

/** Sum the daily rows into one line per campaign, then re-derive the ratios.
 *  Averaging per-day CTRs would weight a 3-impression day like a 30,000 one. */
function rollUp(rows: Row[]): Row[] {
  const byCampaign = new Map<string, Row>();
  for (const row of rows) {
    const existing = byCampaign.get(row.campaignId);
    if (!existing) {
      byCampaign.set(row.campaignId, { ...row, statDate: "" });
      continue;
    }
    existing.spend += row.spend;
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.conversions += row.conversions;
  }
  return [...byCampaign.values()]
    .map((row) => ({
      ...row,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
      cpc: row.clicks > 0 ? row.spend / row.clicks : null,
      cpm: row.impressions > 0 ? row.spend / (row.impressions / 1000) : null,
      cpa: row.conversions > 0 ? row.spend / row.conversions : null,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export function AdsCampaignsPanel() {
  const [state, setState] = useState<Response | null>(null);
  const [busy, setBusy] = useState(true);

  // No setBusy(true) here: this is called from an effect on mount, and setting
  // state synchronously inside one triggers a cascading render. `busy` already
  // starts true, which is exactly the state a mount-time load is in.
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ads/campaigns?days=30", { cache: "no-store" });
      setState((await response.json()) as Response);
    } catch (error) {
      setState({ connected: true, ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Started from a timer rather than the effect body: a fetch that resolves
    // from cache can settle before the effect returns, and setting state
    // synchronously inside an effect cascades renders.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  if (busy && !state) {
    return <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-white/40">Loading…</p>;
  }

  if (state && !state.connected) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-xs leading-6 text-white/45">
        <p className="text-white/70">Not connected.</p>
        <p className="mt-1">{state.reason}</p>
        {state.missing?.length ? (
          <p className="mt-2 font-mono text-[11px] text-white/40">missing: {state.missing.join(", ")}</p>
        ) : null}
      </div>
    );
  }

  if (state && state.ok === false) {
    return (
      <div className="rounded-xl border border-red-400/25 bg-red-400/[0.05] px-4 py-4 text-xs leading-6 text-white/70">
        <p className="font-mono text-red-300">TikTok rejected the request</p>
        <p className="mt-1 font-mono text-[11px] text-white/55">
          code {String(state.code)} · request {state.requestId ?? "—"}
        </p>
        <p className="mt-1">{state.message}</p>
      </div>
    );
  }

  const rows = rollUp(state?.rows ?? []);
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs leading-6 text-white/40">
        Connected — TikTok returned no campaign activity for the last 30 days. That means no spend, not no connection.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-white/35">
        {state?.range ? `${state.range.since} → ${state.range.until}` : null}
        {state?.writesEnabled ? null : " · read-only (writes require TIKTOK_ADS_WRITE_ENABLED)"}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-white/40">
            <tr>
              {["Campaign", "Spend", "Impr.", "CPM", "Clicks", "CTR", "CPC", "Conv.", "CPA"].map((header) => (
                <th key={header} className="pb-2 font-medium uppercase tracking-[0.1em]">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="text-white/75">
            {rows.map((row) => (
              <tr key={row.campaignId} className="border-t border-white/[0.05]">
                <td className="max-w-[18rem] truncate py-2 pr-3 text-white/90">{row.campaignName}</td>
                <td className="pr-3">{money(row.spend)}</td>
                <td className="pr-3">{row.impressions.toLocaleString()}</td>
                <td className="pr-3">{dollars(row.cpm)}</td>
                <td className="pr-3">{row.clicks.toLocaleString()}</td>
                <td className="pr-3">{pct(row.ctr)}</td>
                <td className="pr-3">{dollars(row.cpc)}</td>
                <td className="pr-3">{row.conversions}</td>
                <td className="pr-3">{dollars(row.cpa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
