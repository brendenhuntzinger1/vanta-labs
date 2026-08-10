"use client";

import { useState } from "react";

/**
 * Prove checkout can take a payment, without taking one.
 *
 * The provider is asked for a checkout session exactly as the checkout
 * controller asks — same credentials, same call, from production. A session is
 * not a charge; the storefront abandons one on every abandoned cart. So this
 * answers "will the next real order reach a card form?" for free.
 *
 * It reports the provider's own words on failure rather than a verdict of its
 * own, because a credential problem and an outage need different responses and
 * a paraphrase loses the difference.
 */

type Result = {
  ok?: boolean;
  stage?: string;
  reason?: string;
  paymentIdReturned?: boolean;
  hostedCheckoutUrlReturned?: boolean;
  error?: string;
  config?: {
    provider?: string;
    checkoutEnabled?: boolean;
    veyraApiBase?: boolean;
    veyraSecretKey?: boolean;
    webhookSecret?: boolean;
    siteUrl?: string | null;
  };
};

function Flag({ label, on, warn }: { label: string; on: boolean; warn?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <span className="text-xs text-zinc-300">{label}</span>
      <span className={`font-mono text-[11px] ${on ? "text-emerald-300" : "text-red-300"}`}>
        {on ? "SET" : warn ?? "MISSING"}
      </span>
    </div>
  );
}

export function CheckoutPreflight() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/admin/checkout-preflight", { method: "POST" });
      setResult((await response.json()) as Result);
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vl-panel mx-auto max-w-7xl rounded-2xl p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-300">Checkout preflight</h2>
          <p className="mt-1 max-w-2xl text-xs leading-6 text-zinc-500">
            Asks the payment provider for a checkout session, exactly as checkout does. Nothing is charged, no order is
            created and no stock is held — a session is not a payment. Run this before a real test order.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="rounded-xl border border-cyan-300/40 bg-cyan-400/10 px-4 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Checking…" : "Run preflight"}
        </button>
      </header>

      {result ? (
        <div className="mt-4 space-y-3">
          <p className={`font-mono text-sm ${result.ok ? "text-emerald-300" : "text-red-300"}`}>
            {result.ok ? "READY — a real checkout would reach a card form" : "NOT READY — a real checkout would be refused"}
          </p>
          {result.reason ? <p className="text-xs leading-6 text-zinc-400">{result.reason}</p> : null}
          {result.error ? <p className="font-mono text-xs text-red-300">{result.error}</p> : null}

          {result.config ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Flag label="Checkout enabled" on={Boolean(result.config.checkoutEnabled)} warn="CLOSED" />
              <Flag label="VEYRA_API_BASE" on={Boolean(result.config.veyraApiBase)} />
              <Flag label="Veyra secret key" on={Boolean(result.config.veyraSecretKey)} />
              <Flag label="Webhook secret" on={Boolean(result.config.webhookSecret)} />
              <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <span className="text-xs text-zinc-300">Provider mode</span>
                <span className={`font-mono text-[11px] ${result.config.provider === "mock" ? "text-amber-300" : "text-zinc-300"}`}>
                  {result.config.provider ?? "?"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <span className="text-xs text-zinc-300">Session url returned</span>
                <span className={`font-mono text-[11px] ${result.hostedCheckoutUrlReturned ? "text-emerald-300" : "text-red-300"}`}>
                  {result.hostedCheckoutUrlReturned ? "YES" : "NO"}
                </span>
              </div>
            </div>
          ) : null}

          {result.config?.provider === "mock" ? (
            <p className="rounded-lg border border-amber-300/30 bg-amber-400/[0.06] px-3 py-2 text-xs leading-6 text-amber-100">
              Provider is <span className="font-mono">mock</span>. Checkout works end to end but never charges a real
              card. A green result here does not prove the live processor works.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
