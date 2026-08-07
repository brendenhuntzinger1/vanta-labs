"use client";

import { useCallback, useMemo, useState } from "react";
import type { InventoryLine } from "@/lib/admin-inventory";

// ---------------------------------------------------------------------------
// The manual half of the Inventory page: the summary, the receive drawer, the
// per-line adjustment, and the history.
//
// All of it lives on the one screen on purpose. The operator opens Inventory
// when stock arrives, when a vial goes out for testing, when something breaks,
// or to correct a miscount — four occasional tasks that do not each deserve
// their own page and their own navigation.
//
// Customer sales never appear here as work. They decrement automatically.
// ---------------------------------------------------------------------------

const ADJUST_REASONS = [
  { type: "manual_add", label: "Received from supplier", sign: 1 },
  { type: "refund_restock", label: "Customer return", sign: 1 },
  { type: "manual_subtract", label: "Sent for testing", sign: -1 },
  { type: "damaged", label: "Damaged", sign: -1 },
  { type: "lost", label: "Lost", sign: -1 },
  { type: "correction", label: "Correction (recount)", sign: 1 },
] as const;

export interface HistoryRow {
  id: string;
  productName: string | null;
  sku: string | null;
  typeLabel: string;
  delta: number;
  quantityBefore: number | null;
  quantityAfter: number | null;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

function lineName(row: InventoryLine) {
  return row.variantLabel ? `${row.productName} — ${row.variantLabel}` : row.productName;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" | "bad" }) {
  const colour = tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-300" : "text-zinc-100";
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${colour}`}>{value.toLocaleString()}</p>
    </div>
  );
}

export function InventorySummary({ rows }: { rows: InventoryLine[] }) {
  const stats = useMemo(() => {
    let units = 0;
    let incoming = 0;
    let low = 0;
    let out = 0;
    for (const row of rows) {
      units += row.inventoryQuantity;
      incoming += row.incomingQuantity;
      if (row.isOutOfStock) out += 1;
      else if (row.isLowStock) low += 1;
    }
    return { units, incoming, low, out };
  }, [rows]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Units in stock" value={stats.units} />
      <Stat label="Incoming" value={stats.incoming} />
      <Stat label="Low stock" value={stats.low} tone={stats.low > 0 ? "warn" : undefined} />
      <Stat label="Out of stock" value={stats.out} tone={stats.out > 0 ? "bad" : undefined} />
    </div>
  );
}

// ------------------------------------------------------------- receive ----

interface ReceiveDraft {
  [key: string]: string;
}

export function ReceiveDrawer({
  rows,
  onDone,
}: {
  rows: InventoryLine[];
  onDone: (rows: InventoryLine[] | null, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<ReceiveDraft>({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const entered = useMemo(
    () => Object.entries(draft).filter(([, value]) => Number(value) > 0),
    [draft],
  );
  const totalUnits = entered.reduce((total, [, value]) => total + Math.trunc(Number(value)), 0);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (row) =>
        row.productName.toLowerCase().includes(term) ||
        (row.sku ?? "").toLowerCase().includes(term) ||
        (row.variantLabel ?? "").toLowerCase().includes(term),
    );
  }, [rows, search]);

  const submit = async () => {
    if (entered.length === 0) return;
    setSaving(true);
    try {
      const lines = entered.map(([key, value]) => {
        const row = rows.find((r) => r.key === key)!;
        return { productId: row.productId, doseId: row.doseId, quantity: Math.trunc(Number(value)) };
      });
      const res = await fetch("/api/admin/inventory/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "receive_shipment", lines, reason: reason.trim() || null }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        received?: number;
        failed?: Array<{ message: string }>;
        rows?: InventoryLine[];
        error?: string;
      };
      if (!res.ok) {
        onDone(null, json.error ?? "Could not receive the shipment.");
        return;
      }
      // A partial success is reported as such rather than as a flat failure:
      // the lines that applied really did apply, and the stock is on the shelf.
      const failed = json.failed?.length ?? 0;
      onDone(
        json.rows ?? null,
        failed > 0
          ? `Received ${json.received} line(s); ${failed} failed. Check the counts before closing.`
          : `Received ${json.received} line(s), ${totalUnits} units.`,
      );
      setDraft({});
      setReason("");
      setOpen(false);
    } catch {
      onDone(null, "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="vl-btn-primary whitespace-nowrap px-4 py-2 text-sm">
        Receive inventory
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-emerald-300/30 bg-emerald-400/[0.05] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-emerald-100">Receive a supplier shipment</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-zinc-400 underline">
          Close
        </button>
      </div>
      <p className="mt-1 text-[12px] text-zinc-400">
        Enter what physically arrived. Quantities are <strong>added</strong> to the current counts, so a sale that
        lands while you are typing is not overwritten.
      </p>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter products"
        className="vl-input mt-3 w-full px-3 py-2 text-sm"
      />

      <div className="mt-3 max-h-72 overflow-y-auto rounded-xl border border-white/10">
        {visible.map((row) => (
          <div key={row.key} className="flex items-center gap-3 border-b border-white/5 px-3 py-2 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-200">{lineName(row)}</p>
              <p className="text-[11px] text-zinc-500">
                {row.sku ?? "no SKU"} · {row.inventoryQuantity} on hand
                {row.incomingQuantity > 0 ? ` · ${row.incomingQuantity} expected` : ""}
              </p>
            </div>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={draft[row.key] ?? ""}
              onChange={(e) => setDraft((prev) => ({ ...prev, [row.key]: e.target.value }))}
              placeholder="0"
              aria-label={`Units received of ${lineName(row)}`}
              className="vl-input w-24 shrink-0 px-2 py-2 text-sm"
            />
          </div>
        ))}
        {visible.length === 0 ? <p className="px-3 py-4 text-sm text-zinc-500">No products match.</p> : null}
      </div>

      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Note (supplier, invoice number…) — optional"
        className="vl-input mt-3 w-full px-3 py-2 text-sm"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={saving || entered.length === 0}
          onClick={submit}
          className="vl-btn-primary px-5 py-2.5 text-sm disabled:opacity-40"
        >
          {saving
            ? "Receiving…"
            : entered.length === 0
              ? "Enter quantities"
              : `Receive ${entered.length} line${entered.length === 1 ? "" : "s"} · ${totalUnits} units`}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ adjust ----

export function QuickAdjust({
  row,
  onDone,
}: {
  row: InventoryLine;
  onDone: (rows: InventoryLine[] | null, message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<(typeof ADJUST_REASONS)[number]["type"]>("manual_add");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const selected = ADJUST_REASONS.find((r) => r.type === type)!;
  const magnitude = Math.trunc(Number(amount) || 0);
  const delta = magnitude * selected.sign;

  const submit = async () => {
    if (magnitude <= 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/inventory/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adjust",
          productId: row.productId,
          doseId: row.doseId,
          delta,
          type,
          reason: note.trim() || selected.label,
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string; rows?: InventoryLine[]; quantityAfter?: number };
      if (!res.ok || !json.success) {
        onDone(null, json.error ?? "Could not adjust the count.");
        return;
      }
      onDone(json.rows ?? null, `${lineName(row)} → ${json.quantityAfter} units.`);
      setAmount("");
      setNote("");
      setOpen(false);
    } catch {
      onDone(null, "Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="vl-btn-secondary px-3 py-1.5 text-xs">
        Adjust
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/15 bg-black/30 p-2">
      <select
        value={type}
        onChange={(e) => setType(e.target.value as typeof type)}
        aria-label="Reason"
        className="vl-input px-2 py-1.5 text-xs"
      >
        {ADJUST_REASONS.map((r) => (
          <option key={r.type} value={r.type}>
            {r.sign > 0 ? "+" : "−"} {r.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Units"
        aria-label="Units"
        className="vl-input px-2 py-1.5 text-xs"
      />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="vl-input px-2 py-1.5 text-xs"
      />
      {magnitude > 0 ? (
        <p className="text-[11px] text-zinc-400">
          {row.inventoryQuantity} → <strong className="text-zinc-200">{Math.max(0, row.inventoryQuantity + delta)}</strong>
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving || magnitude <= 0}
          onClick={submit}
          className="vl-btn-primary flex-1 px-2 py-1.5 text-xs disabled:opacity-40"
        >
          {saving ? "Saving…" : "Apply"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="vl-btn-secondary px-2 py-1.5 text-xs">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- history ----

export function InventoryHistory() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/inventory/operations?limit=100");
      const json = (await res.json()) as { history?: HistoryRow[] };
      setRows(json.history ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && rows === null) void load();
  };

  return (
    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-zinc-100">Inventory history</span>
        <span className="text-xs text-zinc-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open ? (
        <div className="border-t border-white/10 px-4 py-3">
          {loading ? (
            <p className="text-sm text-zinc-400">Loading…</p>
          ) : !rows || rows.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No movements recorded yet. Every change made here is logged with what, when, why and by whom.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2 pr-4">When</th>
                    <th className="pb-2 pr-4">Product</th>
                    <th className="pb-2 pr-4">Reason</th>
                    <th className="pb-2 pr-4 text-right">Change</th>
                    <th className="pb-2 pr-4 text-right">Before → After</th>
                    <th className="pb-2">By</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t border-white/10">
                      <td className="py-2 pr-4 text-[12px] text-zinc-400">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-zinc-200">
                        {row.productName ?? "—"}
                        {row.sku ? <span className="text-zinc-500"> · {row.sku}</span> : null}
                      </td>
                      <td className="py-2 pr-4 text-zinc-300">
                        {row.typeLabel}
                        {row.reason ? <span className="block text-[11px] text-zinc-500">{row.reason}</span> : null}
                      </td>
                      <td
                        className={`py-2 pr-4 text-right tabular-nums ${row.delta >= 0 ? "text-emerald-300" : "text-rose-300"}`}
                      >
                        {row.delta > 0 ? `+${row.delta}` : row.delta}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-zinc-400">
                        {row.quantityBefore ?? "—"} → {row.quantityAfter ?? "—"}
                      </td>
                      <td className="py-2 text-[12px] text-zinc-400">{row.actor ?? "system"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
