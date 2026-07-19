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
  updatedAt: string;
};

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function AdminLiveMetrics({ initial }: { initial: MetricsState }) {
  const [metrics, setMetrics] = useState<MetricsState>(initial);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/metrics", { cache: "no-store" });
        const json = await response.json() as {
          success: boolean;
          metrics?: MetricsState;
        };

        if (!cancelled && response.ok && json.success && json.metrics) {
          setMetrics(json.metrics);
        }
      } catch {
        // Ignore transient network errors and keep the last known values.
      }
    };

    const timer = setInterval(() => {
      void refresh();
    }, 15_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const lastUpdatedLabel = useMemo(() => {
    const parsed = Date.parse(metrics.updatedAt);
    if (!Number.isFinite(parsed)) {
      return "Live";
    }
    return `Updated ${new Date(parsed).toLocaleTimeString()}`;
  }, [metrics.updatedAt]);

  return (
    <>
      <div className="vl-panel rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue Today</p>
        <p className="mt-2 text-2xl font-semibold text-white">{money(metrics.revenue.today)}</p>
      </div>
      <div className="vl-panel rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue Last 7 Days</p>
        <p className="mt-2 text-2xl font-semibold text-white">{money(metrics.revenue.last7Days)}</p>
      </div>
      <div className="vl-panel rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue Last 30 Days</p>
        <p className="mt-2 text-2xl font-semibold text-white">{money(metrics.revenue.last30Days)}</p>
      </div>
      <div className="vl-panel rounded-2xl p-4">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Online Now (5m)</p>
        <p className="mt-2 text-2xl font-semibold text-white">{metrics.onlineNow}</p>
        <p className="mt-1 text-xs text-zinc-500">{lastUpdatedLabel}</p>
      </div>
    </>
  );
}
