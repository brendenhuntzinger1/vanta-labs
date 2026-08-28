"use client";

import { useEffect, useMemo, useState } from "react";

type RevenueMetrics = {
  today: number;
  last7Days: number;
  last30Days: number;
};

type MetricsState = {
  onlineNow: number;
  revenue: RevenueMetrics;
  selectedRange: {
    preset: string;
    fromIso: string;
    toIso: string;
    total: number;
    trend: Array<{ date: string; amount: number }>;
  };
  updatedAt: string;
};

type RangePreset = "today" | "7d" | "30d" | "90d" | "custom";

function isoDateInput(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

/**
 * `initialUnavailable` — the server could not read these figures, so `initial`
 * is a placeholder rather than an answer.
 *
 * The page around this component renders every unread figure as an em dash and
 * tells the operator so. This component was handed zeros and rendered them as
 * "$0.00" and "0" in the largest type in the stat grid, directly beneath that
 * promise. The client refresh does not rescue it either: /api/admin/metrics
 * Promise.alls the same reads, so when they are down the fetch 500s, the catch
 * below deliberately keeps the last known values, and the zeros stay on screen
 * for as long as the outage lasts.
 *
 * So the placeholder is marked as one, and cleared the moment a real payload
 * arrives.
 */
export function AdminLiveMetrics({ initial, initialUnavailable = false }: { initial: MetricsState; initialUnavailable?: boolean }) {
  const [metrics, setMetrics] = useState<MetricsState>(initial);
  const [unavailable, setUnavailable] = useState(initialUnavailable);
  const [preset, setPreset] = useState<RangePreset>("7d");
  const [fromDate, setFromDate] = useState(isoDateInput(initial.selectedRange.fromIso));
  const [toDate, setToDate] = useState(isoDateInput(initial.selectedRange.toIso));

  const requestQuery = useMemo(() => {
    const params = new URLSearchParams({ preset });
    if (preset === "custom" && fromDate && toDate) {
      params.set("from", fromDate);
      params.set("to", toDate);
    }
    return params.toString();
  }, [preset, fromDate, toDate]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch(`/api/admin/metrics?${requestQuery}`, { cache: "no-store" });
        const json = await response.json() as {
          success: boolean;
          metrics?: MetricsState;
        };

        if (!cancelled && response.ok && json.success && json.metrics) {
          setMetrics(json.metrics);
          // A real payload landed — whatever the server could not read at
          // render time, it can read now.
          setUnavailable(false);
        }
      } catch {
        // Ignore transient network errors and keep the last known values.
      }
    };

    const timer = setInterval(() => {
      void refresh();
    }, 15_000);

    void refresh();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [requestQuery]);

  const lastUpdatedLabel = useMemo(() => {
    const parsed = Date.parse(metrics.updatedAt);
    if (!Number.isFinite(parsed)) {
      return "Live";
    }
    return `Updated ${new Date(parsed).toLocaleTimeString()}`;
  }, [metrics.updatedAt]);

  const trendMax = useMemo(() => {
    const max = Math.max(...metrics.selectedRange.trend.map((point) => point.amount), 0);
    return max <= 0 ? 1 : max;
  }, [metrics.selectedRange.trend]);

  const rangeLabel = useMemo(() => {
    const from = isoDateInput(metrics.selectedRange.fromIso);
    const to = isoDateInput(metrics.selectedRange.toIso);
    return `${from} to ${to}`;
  }, [metrics.selectedRange.fromIso, metrics.selectedRange.toIso]);

  return (
    <>
      {/*
        Revenue today / 7d / 30d used to be three tiles here AND the subline of
        the "Revenue \u00b7 30d" tile above — the same three numbers rendered twice in
        one row, taking the space the work queue needed. The tile above is the
        one that stays; the trend chart below carries the range detail.
      */}
      <div className="vl-panel rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Online Now (5m)</p>
        <p className="mt-2 text-2xl font-semibold text-white">{unavailable ? "\u2014" : metrics.onlineNow}</p>
        <p className="mt-1 text-xs text-zinc-500">{unavailable ? "Could not be read" : lastUpdatedLabel}</p>
      </div>

      <div className="vl-panel rounded-2xl p-4 sm:col-span-2 lg:col-span-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue Trend</p>
            <p className="mt-2 text-2xl font-semibold text-white">{unavailable ? "\u2014" : money(metrics.selectedRange.total)}</p>
            <p className="mt-1 text-xs text-zinc-500">{unavailable ? "Could not be read" : rangeLabel}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["today", "7d", "30d", "90d", "custom"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPreset(value)}
                className={`${preset === value ? "vl-btn-primary" : "vl-btn-secondary"} px-3 py-1.5 text-xs`}
              >
                {value === "today" ? "Today" : value === "7d" ? "7 Days" : value === "30d" ? "30 Days" : value === "90d" ? "90 Days" : "Custom"}
              </button>
            ))}
          </div>
        </div>

        {preset === "custom" ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:max-w-xl">
            <label className="text-xs uppercase tracking-[0.16em] text-zinc-500">
              From
              <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </label>
            <label className="text-xs uppercase tracking-[0.16em] text-zinc-500">
              To
              <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
            </label>
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-7 gap-2 sm:grid-cols-10 lg:grid-cols-14">
          {metrics.selectedRange.trend.map((point) => {
            const heightPercent = Math.max(6, Math.round((point.amount / trendMax) * 100));
            return (
              <div key={point.date} className="flex flex-col items-center gap-2">
                <div className="flex h-28 w-full items-end rounded-md bg-white/5 p-1">
                  <div className="w-full rounded-sm bg-white/80" style={{ height: `${heightPercent}%` }} />
                </div>
                <p className="text-[10px] uppercase tracking-[0.1em] text-zinc-500">{point.date.slice(5)}</p>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
