"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Whether the database itself is preventing oversell.
 *
 * The most consequential unknown before launch, and the least visible: the
 * reservation layer fails open, so a missing migration looks exactly like a
 * working one until two customers buy the same last unit. This states it
 * plainly, and distinguishes "not applied" from "could not check" — a failed
 * probe is not evidence that anything is wrong.
 */

type Check = { name: string; present: boolean; detail: string };
type Payload = { applied?: boolean; inconclusive?: boolean; checks?: Check[]; summary?: string; error?: string };

export function InventoryReservationCheck() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/inventory-reservation-check", { cache: "no-store" });
      setData((await response.json()) as Payload);
    } catch (error) {
      setData({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const tone = data?.inconclusive
    ? "border-sky-300/30 bg-sky-300/[0.06] text-sky-100"
    : data?.applied
      ? "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100"
      : "border-rose-400/40 bg-rose-400/[0.08] text-rose-100";

  const verdict = data?.inconclusive ? "CANNOT DETERMINE" : data?.applied ? "APPLIED" : "NOT APPLIED";

  return (
    <section className="vl-panel mx-auto max-w-7xl rounded-2xl p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-300">Inventory reservation</h2>
          <p className="mt-1 max-w-2xl text-xs leading-6 text-zinc-500">
            Checks the live database for the objects that stop two customers buying the same last unit. Read-only — it
            reads two columns, one table and the schema the database publishes about itself, and calls none of the
            reservation functions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-xl border border-white/15 px-4 py-2 text-xs text-zinc-300 transition hover:border-white/30 hover:text-white"
        >
          Re-check
        </button>
      </header>

      {busy && !data ? (
        <p className="mt-4 text-xs text-zinc-500">Checking…</p>
      ) : data?.error ? (
        <p className="mt-4 font-mono text-xs text-rose-300">{data.error}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className={`rounded-xl border px-4 py-3 ${tone}`}>
            <p className="font-mono text-sm">{verdict}</p>
            <p className="mt-1 text-xs leading-6 opacity-90">{data?.summary}</p>
          </div>

          <ul className="grid gap-2 sm:grid-cols-2">
            {(data?.checks ?? []).map((check) => (
              <li
                key={check.name}
                className="flex items-start justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2"
              >
                <span className="font-mono text-[11px] text-zinc-300">{check.name}</span>
                <span className={`font-mono text-[11px] ${check.present ? "text-emerald-300" : "text-rose-300"}`}>
                  {check.present ? "OK" : "MISSING"}
                </span>
              </li>
            ))}
          </ul>

          {data && !data.applied && !data.inconclusive ? (
            <div className="rounded-xl border border-rose-400/25 bg-rose-400/[0.05] px-4 py-3 text-xs leading-6 text-rose-100">
              <p className="font-semibold">To fix, once:</p>
              <p className="mt-1 text-rose-100/80">
                Supabase → SQL Editor → New query → paste the contents of{" "}
                <code className="font-mono">src/lib/sql/inventory-reservations.sql</code> → Run. It is written with
                <code className="mx-1 font-mono">if not exists</code>, so running it twice is safe. Then press Re-check.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
