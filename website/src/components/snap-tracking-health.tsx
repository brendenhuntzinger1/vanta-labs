"use client";

import { useCallback, useEffect, useState } from "react";
import { observeSnap } from "@/lib/ads/snap-health-browser";
import { buildSnapHealthReport, snapDetectorExplanation, UNTESTED_SNAP, type SnapHealthCheck } from "@/lib/ads/snap-health";
import { SNAP_PIXEL_ID } from "@/components/snap-pixel";
import type { HealthStatus } from "@/lib/ads/tracking-health";

/**
 * Snapchat's half of the tracking board.
 *
 * It exists because Snapchat's own installation checker cannot tell a correctly
 * gated pixel from a broken one. Their crawler is served no pixel — it never
 * accepts the cookie banner — so it reports "we can't detect it" permanently,
 * for a pixel that works perfectly for every real visitor who accepts. Reading
 * that amber warning as a fault leads to exactly the wrong repair: removing the
 * consent gate.
 *
 * So this measures the same thing from inside a browser that *has* consented,
 * where the answer is knowable, and says plainly which side established each
 * fact.
 */

const TONE: Record<HealthStatus, string> = {
  PASS: "text-emerald-300 border-emerald-400/30 bg-emerald-400/[0.07]",
  VERIFIED: "text-emerald-300 border-emerald-400/30 bg-emerald-400/[0.07]",
  AVAILABLE: "text-emerald-300 border-emerald-400/30 bg-emerald-400/[0.07]",
  FAIL: "text-red-300 border-red-400/30 bg-red-400/[0.07]",
  NOT_VERIFIED: "text-[color:var(--accent-gold)] border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/[0.07]",
  NOT_AVAILABLE: "text-white/45 border-white/10 bg-white/[0.02]",
  NOT_TESTED: "text-white/45 border-white/10 bg-white/[0.02]",
};

const TIER_TONE = {
  CODE: "text-white/35",
  PRODUCTION: "text-sky-300/70",
  SNAP: "text-[color:var(--accent-gold)]/80",
} as const;

function Row({ check }: { check: SnapHealthCheck }) {
  return (
    <div className="grid gap-2 border-t border-white/[0.05] py-3 sm:grid-cols-[13rem_7.5rem_1fr] sm:items-start sm:gap-4">
      <div>
        <p className="text-xs text-white/85">{check.label}</p>
        <p className={`mt-0.5 text-[10px] uppercase tracking-[0.14em] ${TIER_TONE[check.tier]}`}>{check.tier}</p>
      </div>
      <span className={`inline-flex h-fit w-fit rounded-md border px-2 py-1 font-mono text-[11px] ${TONE[check.status]}`}>
        {check.status.replace("_", " ")}
      </span>
      <div>
        <p className="text-xs leading-6 text-white/55">{check.detail}</p>
        {check.action ? <p className="mt-1 text-xs leading-6 text-[color:var(--accent-gold)]/80">→ {check.action}</p> : null}
      </div>
    </div>
  );
}

export function SnapTrackingHealth() {
  const [snap, setSnap] = useState(UNTESTED_SNAP);

  const refresh = useCallback(() => {
    setSnap(observeSnap(SNAP_PIXEL_ID));
  }, []);

  useEffect(() => {
    // A short delay lets sc-static.net finish downloading before it is looked
    // for; reading immediately reports a false "SDK blocked" on a slow line.
    const timer = setTimeout(refresh, 1800);
    return () => clearTimeout(timer);
  }, [refresh]);

  const checks = buildSnapHealthReport(snap);
  const green = checks.filter((check) => ["PASS", "VERIFIED", "AVAILABLE"].includes(check.status)).length;
  const red = checks.filter((check) => check.status === "FAIL").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-white/50">
          <span className="font-mono text-emerald-300">{green}</span> green ·{" "}
          <span className="font-mono text-red-300">{red}</span> failing ·{" "}
          <span className="font-mono text-white/40">{checks.length - green - red}</span> untested
        </p>
        <button
          type="button"
          onClick={refresh}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 transition hover:border-white/25 hover:text-white"
        >
          Re-run checks
        </button>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
        <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">
          Why Snapchat says &ldquo;we can&rsquo;t detect it&rdquo;
        </p>
        <p className="mt-1 text-xs leading-6 text-white/55">{snapDetectorExplanation(snap)}</p>
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-black/20 px-4 pb-2">
        {checks.map((check) => (
          <Row key={check.id} check={check} />
        ))}
      </div>

      <p className="text-xs leading-6 text-white/40">
        Pixel <span className="font-mono text-white/60">{SNAP_PIXEL_ID}</span>. The cookie-choice buttons on the TikTok
        board apply here too — both pixels read the same stored consent.
      </p>
    </div>
  );
}
