"use client";

import { useCallback, useEffect, useState } from "react";
import { observeBrowser, setConsentForThisBrowser } from "@/lib/ads/tracking-health-browser";
import {
  buildHealthReport,
  nextAction,
  UNTESTED_BROWSER,
  type HealthCheck,
  type HealthStatus,
  type ProbeResult,
  type ServerHealthInput,
} from "@/lib/ads/tracking-health";
import { buildGoogleHealth } from "@/lib/ads/google-health";

/**
 * Tracking Health — the answer to "is this actually working?", without a
 * browser console, a SQL editor, or a tour of Events Manager.
 *
 * It runs the checks rather than describing them. The server half arrives from
 * an admin-only endpoint; the browser half is measured right here, in the real
 * deployed bundle on the real domain, which is the only place several of these
 * facts exist. Both halves feed the same pure report builder, so what you read
 * is derived from observations and never from an opinion this component holds.
 *
 * Every row shows who established it: CODE (provable from the repository),
 * PRODUCTION (observed on the live deployment), PLATFORM (the ad platform
 * itself said so). The
 * distinction is the point — a board of green CODE rows is exactly the state
 * that fools people into thinking a dead pixel is alive.
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
  PLATFORM: "text-[color:var(--accent-gold)]/80",
} as const;

function Row({ check }: { check: HealthCheck }) {
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
        {check.action ? (
          <p className="mt-1 text-xs leading-6 text-[color:var(--accent-gold)]/80">→ {check.action}</p>
        ) : null}
      </div>
    </div>
  );
}

type TestEventResponse = {
  delivered?: boolean;
  reason?: string;
  tiktok?: { code: number | null; message: string | null; requestId: string | null; httpStatus: number | null };
  transportError?: string | null;
};

type OrderInspection = {
  orderId?: string;
  paymentStatus?: string | null;
  isPaid?: boolean;
  amountPaid?: number;
  wouldReport?: boolean;
  alreadySent?: boolean;
  eventsApiConfigured?: boolean;
  reason?: string | null;
  error?: string;
  event?: { name: string; eventId: string; properties: Record<string, unknown> } | null;
};

/**
 * Read back the Purchase a real order produces — without producing it.
 *
 * Testing a purchase honestly means paying for one, and having done that you
 * should be able to see the resulting event rather than infer it from the
 * absence of an error. This shows the exact payload: whether the order counts
 * as paid, the value, the content ids, and the event id the server and browser
 * both send. It sends nothing, so checking cannot create a conversion.
 */
function OrderInspector() {
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OrderInspection | null>(null);

  async function inspect() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/ads/purchase-event/${encodeURIComponent(orderId.trim())}?inspect=1`, {
        cache: "no-store",
      });
      setResult((await response.json()) as OrderInspection);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Inspect an order&rsquo;s Purchase event</p>
      <p className="mt-1 text-xs leading-6 text-white/45">
        Shows exactly what a real order reports, and sends nothing. Purchase fires only when the order&rsquo;s own
        payment status is paid, so this is the way to confirm the most important event without creating a conversion.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          placeholder="Order ID"
          aria-label="Order ID"
          className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white placeholder:text-white/25"
        />
        <button
          type="button"
          onClick={() => void inspect()}
          disabled={busy || !orderId.trim()}
          className="rounded-lg border border-white/15 px-4 py-2 text-xs text-white/70 transition hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Reading…" : "Inspect"}
        </button>
      </div>
      {result ? (
        <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/30 p-3 text-xs">
          {result.error ? (
            <p className="font-mono text-red-300">{result.error}</p>
          ) : (
            <>
              <p className={`font-mono ${result.wouldReport ? "text-emerald-300" : "text-[color:var(--accent-gold)]"}`}>
                {result.wouldReport ? "REPORTS A CONVERSION" : "REPORTS NOTHING"}
              </p>
              <p className="mt-1 font-mono text-[11px] text-white/50">
                payment_status {String(result.paymentStatus)} · amount_paid {String(result.amountPaid)} ·
                {result.alreadySent ? " already sent" : " not yet recorded"}
              </p>
              {result.reason ? <p className="mt-1 text-white/55">{result.reason}</p> : null}
              {result.event ? (
                <pre className="mt-2 overflow-x-auto rounded bg-black/40 p-2 font-mono text-[10px] leading-5 text-white/60">
{JSON.stringify({ event: result.event.name, event_id: result.event.eventId, ...result.event.properties }, null, 2)}
                </pre>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AdsTrackingHealth() {
  const [server, setServer] = useState<ServerHealthInput | null>(null);
  const [browser, setBrowser] = useState(UNTESTED_BROWSER);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [testCode, setTestCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    // Measured first: it needs no network, so the board is useful even if the
    // server call fails.
    setBrowser(observeBrowser());
    try {
      const response = await fetch("/api/ads/tracking-health", { cache: "no-store" });
      if (!response.ok) throw new Error(`server checks returned ${response.status}`);
      setServer((await response.json()) as ServerHealthInput);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // A short delay lets the pixel finish loading before it is looked for;
    // reading immediately would report a false absence on a slow connection.
    const timer = setTimeout(() => void refresh(), 1200);
    return () => clearTimeout(timer);
  }, [refresh]);

  const runLiveCheck = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/ads/tiktok-test-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testEventCode: testCode.trim() }),
      });
      const body = (await response.json()) as TestEventResponse;
      setProbe({
        attempted: true,
        delivered: Boolean(body.delivered),
        code: body.tiktok?.code ?? null,
        message: body.tiktok?.message ?? body.reason ?? null,
        requestId: body.tiktok?.requestId ?? null,
        transportError: body.transportError ?? null,
      });
    } catch (e) {
      setProbe({
        attempted: true, delivered: false, code: null, message: null, requestId: null,
        transportError: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [testCode, refresh]);

  if (!server) {
    return (
      <p className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-xs text-white/40">
        {error ? `Could not run the server checks — ${error}` : "Running checks…"}
      </p>
    );
  }

  const checks = [
    ...buildHealthReport({ ...server, probe }, browser),
    ...(server.google ? buildGoogleHealth(server.google) : []),
  ];
  const action = nextAction(checks);
  const green = checks.filter((c) => ["PASS", "VERIFIED", "AVAILABLE"].includes(c.status)).length;
  const red = checks.filter((c) => c.status === "FAIL").length;

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
          onClick={() => void refresh()}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 transition hover:border-white/25 hover:text-white"
        >
          Re-run checks
        </button>
      </div>

      {action ? (
        <div className="rounded-xl border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.05] px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.14em] text-[color:var(--accent-gold)]/70">Next action</p>
          <p className="mt-1 text-sm leading-6 text-white/80">{action}</p>
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/[0.07] bg-black/20 px-4 pb-2">
        {checks.map((check) => (
          <Row key={check.id} check={check} />
        ))}
      </div>

      <OrderInspector />

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">
          Cookie choice in this browser — <span className="font-mono text-white/70">{browser.consent}</span>
        </p>
        <p className="mt-1 text-xs leading-6 text-white/45">
          The pixel does not load until this says <span className="font-mono text-white/70">accepted</span>, and the
          banner only appears while no choice is stored — so a Decline made once is invisible and never asked again.
          These write the same value the banner writes, for this browser only.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setConsentForThisBrowser("accepted");
              // The pixel needs a fresh load to inject its script.
              window.location.reload();
            }}
            className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-300 transition hover:bg-emerald-400/20"
          >
            Accept in this browser and reload
          </button>
          <button
            type="button"
            onClick={() => {
              setConsentForThisBrowser(null);
              window.location.reload();
            }}
            className="rounded-lg border border-white/10 px-4 py-2 text-xs text-white/55 transition hover:border-white/25 hover:text-white"
          >
            Clear choice (show the banner again)
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">Live TikTok check</p>
        <p className="mt-1 text-xs leading-6 text-white/45">
          Sends one server event and reports TikTok&rsquo;s own response. The test code routes it to Test Events instead of
          your reporting, and it is required for exactly that reason — without it this would post a fabricated purchase
          into production numbers. Find it in Events Manager → your pixel → Test Events.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={testCode}
            onChange={(e) => setTestCode(e.target.value)}
            placeholder="TEST12345"
            aria-label="TikTok test event code"
            className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs text-white placeholder:text-white/25"
          />
          <button
            type="button"
            onClick={() => void runLiveCheck()}
            disabled={busy || !testCode.trim()}
            className="rounded-lg border border-[color:var(--accent-gold)]/40 bg-[color:var(--accent-gold)]/10 px-4 py-2 text-xs text-[color:var(--accent-gold)] transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Calling TikTok…" : "Run live check"}
          </button>
        </div>
        {probe ? (
          <p className="mt-3 font-mono text-[11px] text-white/55">
            code {String(probe.code)} · request {probe.requestId ?? "—"}
            {probe.message ? ` · ${probe.message}` : ""}
            {probe.transportError ? ` · ${probe.transportError}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}
