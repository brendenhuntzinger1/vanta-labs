"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDurationShort } from "@/lib/duration-format";

export interface LiveVisitorView {
  key: string;
  displayName: string;
  isAnonymous: boolean;
  pagePath: string;
  deviceType: string;
  browserClass: string;
  location: string | null;
  firstSeen: string;
  lastSeen: string;
  isReturningVisitor: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
}

const POLL_INTERVAL_MS = 5_000;
const CLOCK_TICK_MS = 1_000;

function attributionLabel(visitor: LiveVisitorView): string | null {
  const parts = [visitor.utmSource, visitor.utmMedium, visitor.utmCampaign].filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

/**
 * `initialUnavailable` — the server could not read the live list at render
 * time, so `initial` is empty rather than an answer. Same convention as
 * AdminLiveMetrics: a failed read renders as "unknown", never as a silent
 * zero that looks like an empty store.
 */
export function AdminLiveVisitorsClient({
  initial,
  initialUnavailable = false,
}: {
  initial: LiveVisitorView[];
  initialUnavailable?: boolean;
}) {
  const [visitors, setVisitors] = useState<LiveVisitorView[]>(initial);
  const [unavailable, setUnavailable] = useState(initialUnavailable);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch("/api/admin/live-visitors", { cache: "no-store" });
        const json = (await response.json()) as { success: boolean; visitors?: LiveVisitorView[] };
        if (!cancelled && response.ok && json.success && json.visitors) {
          setVisitors(json.visitors);
          setUnavailable(false);
        } else if (!cancelled && !response.ok) {
          // A failed poll must not be mistaken for "nobody's here" — keep the
          // last known list on screen, and say the number is unconfirmed.
          setUnavailable(true);
        }
      } catch {
        setUnavailable(true);
      }
    };

    const pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    void refresh();

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
    };
  }, []);

  useEffect(() => {
    const clockTimer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(clockTimer);
  }, []);

  const count = visitors.length;

  const countLabel = useMemo(() => {
    if (unavailable && visitors.length === 0) return "—";
    return String(count);
  }, [unavailable, visitors.length, count]);

  return (
    <div className="mt-6 space-y-4">
      <div className="vl-panel rounded-2xl p-5">
        <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">On site right now</p>
        <p className="mt-2 text-4xl font-semibold text-white">{countLabel}</p>
        <p className="mt-1 text-xs text-zinc-500">
          {unavailable
            ? "Could not refresh the live list — showing the last known state."
            : "Refreshes automatically every 5 seconds."}
        </p>
      </div>

      {count === 0 && !unavailable ? (
        <div className="vl-panel rounded-2xl p-5 text-sm text-zinc-400">Nobody&apos;s on the site right now.</div>
      ) : (
        <div className="space-y-2">
          {visitors.map((visitor) => {
            const sinceMs = now - Date.parse(visitor.firstSeen);
            const lastActiveMs = now - Date.parse(visitor.lastSeen);
            const attribution = attributionLabel(visitor);

            return (
              <div key={visitor.key} className="vl-panel rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {visitor.displayName}
                      {visitor.isAnonymous ? null : (
                        <span className="ml-2 rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-200">
                          Signed in
                        </span>
                      )}
                      <span
                        className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          visitor.isReturningVisitor
                            ? "border-amber-300/30 bg-amber-400/10 text-amber-200"
                            : "border-emerald-300/30 bg-emerald-400/10 text-emerald-200"
                        }`}
                      >
                        {visitor.isReturningVisitor ? "Returning" : "New"}
                      </span>
                    </p>
                    <p className="mt-1 font-mono text-xs text-zinc-400">{visitor.pagePath}</p>
                  </div>
                  <div className="text-right text-xs text-zinc-500">
                    <p>Here {formatDurationShort(Math.max(sinceMs, 0))}</p>
                    <p>Active {formatDurationShort(Math.max(lastActiveMs, 0))} ago</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
                  <span>
                    {visitor.deviceType} {"·"} {visitor.browserClass}
                  </span>
                  <span>{visitor.location ?? "Location unknown"}</span>
                  {attribution ? <span>via {attribution}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
