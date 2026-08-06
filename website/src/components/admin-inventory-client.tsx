"use client";

import { useMemo, useState } from "react";
import type { InventoryLine } from "@/lib/admin-inventory";
import { lineWeightOz } from "@/lib/shippo/parcel";

type StatusFilter = "all" | "low" | "out" | "unweighed";

/** Ounces. Mirrors MAX_UNIT_WEIGHT_OZ in admin-inventory.ts — 70 lb. */
const MAX_UNIT_WEIGHT_OZ = 1120;

interface LineDraft {
  quantity: string;
  threshold: string;
  /** Blank means "no weight of my own" — inherit the product, or the default. */
  weight: string;
}

function draftFromRow(row: InventoryLine): LineDraft {
  return {
    quantity: String(row.inventoryQuantity),
    threshold: String(row.lowStockThreshold),
    weight: row.shippingWeightOz === null ? "" : String(row.shippingWeightOz),
  };
}

function sameDraft(a: LineDraft, b: LineDraft) {
  return a.quantity === b.quantity && a.threshold === b.threshold && a.weight.trim() === b.weight.trim();
}

function lineName(row: InventoryLine) {
  return row.variantLabel ? `${row.productName} — ${row.variantLabel}` : row.productName;
}

/**
 * Where the weight the label will actually use comes from. Said out loud
 * because a blank field is genuinely ambiguous otherwise: on a dose it means
 * "same as the product", on a product it means "nobody has weighed this yet",
 * and only one of those is a to-do.
 */
function weightSourceNote(row: InventoryLine): string {
  if (row.shippingWeightSource === "line") return "Weighed";
  if (row.shippingWeightSource === "inherited") return "From product";
  return "Catalog default — not weighed yet";
}

function weightSourceClasses(row: InventoryLine): string {
  if (row.shippingWeightSource === "line") return "text-emerald-300/90";
  if (row.shippingWeightSource === "inherited") return "text-zinc-400";
  return "text-amber-300/90";
}

function StatusPill({ row, enforced }: { row: InventoryLine; enforced: boolean }) {
  if (!enforced) {
    return <span className="rounded-full bg-cyan-400/15 px-2 py-1 text-xs text-cyan-200">Not enforced</span>;
  }
  if (row.isOutOfStock) {
    return <span className="rounded-full bg-rose-500/15 px-2 py-1 text-xs text-rose-300">Out of stock</span>;
  }
  if (row.isLowStock) {
    return <span className="rounded-full bg-amber-400/15 px-2 py-1 text-xs text-amber-300">Low stock</span>;
  }
  return <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300">In stock</span>;
}

export function AdminInventoryClient({
  initialRows,
  canManage,
  inventoryTrackingActive = true,
}: {
  initialRows: InventoryLine[];
  canManage: boolean;
  inventoryTrackingActive?: boolean;
}) {
  const [rows, setRows] = useState<InventoryLine[]>(initialRows);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const draftFor = (row: InventoryLine): LineDraft => drafts[row.key] ?? draftFromRow(row);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter === "low" && !row.isLowStock) return false;
      if (statusFilter === "out" && !row.isOutOfStock) return false;
      if (statusFilter === "unweighed" && row.shippingWeightSource === "line") return false;
      if (!term) return true;
      return row.productName.toLowerCase().includes(term)
        || row.productSlug.toLowerCase().includes(term)
        || (row.sku ?? "").toLowerCase().includes(term)
        || (row.variantLabel ?? "").toLowerCase().includes(term);
    });
  }, [rows, search, statusFilter]);

  // Progress toward "every line has a real count", which is the work that has
  // to be finished before inventory enforcement can safely be switched on.
  const zeroCount = useMemo(() => rows.filter((row) => row.inventoryQuantity <= 0).length, [rows]);
  const unweighedCount = useMemo(() => rows.filter((row) => row.shippingWeightSource !== "line").length, [rows]);

  const dirtyKeys = useMemo(
    () => rows.filter((row) => !sameDraft(draftFor(row), draftFromRow(row))).map((row) => row.key),
    // draftFor closes over `drafts`, which is the dependency that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, drafts],
  );

  const setDraft = (key: string, row: InventoryLine, field: keyof LineDraft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? draftFromRow(row)), [field]: value },
    }));
  };

  /**
   * Validate one line's edits. Returns the payload to send, or the sentence to
   * show the operator. Nothing is sent until every field on the line is sane —
   * a half-applied row (new quantity, rejected weight) is worse than a refusal.
   */
  const readDraft = (row: InventoryLine):
    | { ok: true; quantity: number; threshold: number; weight: number | null }
    | { ok: false; message: string } => {
    const draft = draftFor(row);
    const quantity = Number(draft.quantity);
    const threshold = Number(draft.threshold);

    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(threshold) || threshold < 0) {
      return { ok: false, message: `${lineName(row)}: enter valid non-negative numbers for quantity and threshold.` };
    }

    const rawWeight = draft.weight.trim();
    if (rawWeight === "") {
      return { ok: true, quantity, threshold, weight: null };
    }

    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) {
      return { ok: false, message: `${lineName(row)}: shipping weight must be greater than zero, or blank to inherit.` };
    }
    if (weight > MAX_UNIT_WEIGHT_OZ) {
      return { ok: false, message: `${lineName(row)}: ${weight} oz is heavier than any carrier accepts. Enter ounces, not pounds.` };
    }

    return { ok: true, quantity, threshold, weight };
  };

  const applySaved = (row: InventoryLine, quantity: number, threshold: number, weight: number | null) => {
    setRows((prev) => prev.map((line) => {
      if (line.key !== row.key) return line;

      const effectiveShippingWeightOz = lineWeightOz({
        doseWeightOz: line.doseId ? weight : null,
        productWeightOz: line.doseId ? line.inheritedShippingWeightOz : weight,
      });

      return {
        ...line,
        inventoryQuantity: quantity,
        lowStockThreshold: threshold,
        isOutOfStock: quantity <= 0,
        isLowStock: quantity > 0 && quantity <= threshold,
        shippingWeightOz: weight,
        effectiveShippingWeightOz,
        shippingWeightSource: weight !== null
          ? "line"
          : line.inheritedShippingWeightOz !== null
            ? "inherited"
            : "default",
      };
    }));

    // A saved line is no longer a draft, so the dirty marker clears with it.
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[row.key];
      return next;
    });
  };

  const persistLine = async (row: InventoryLine): Promise<string | null> => {
    const parsed = readDraft(row);
    if (!parsed.ok) {
      return parsed.message;
    }

    const response = await fetch("/api/admin/inventory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: row.productId,
        doseId: row.doseId,
        quantity: parsed.quantity,
        lowStockThreshold: parsed.threshold,
        // Always sent, so clearing the field really does clear the stored
        // override rather than silently leaving the old weight in place.
        shippingWeightOz: parsed.weight,
      }),
    });
    const result = await response.json() as { success: boolean; error?: string };
    if (!result.success) {
      return `${lineName(row)}: ${result.error ?? "unable to update."}`;
    }

    applySaved(row, parsed.quantity, parsed.threshold, parsed.weight);
    return null;
  };

  const saveLine = async (row: InventoryLine) => {
    setBusyKey(row.key);
    setMessage(null);
    try {
      const error = await persistLine(row);
      setMessage(error ?? `Updated ${lineName(row)}.`);
    } catch {
      setMessage("Unable to update inventory right now.");
    } finally {
      setBusyKey(null);
    }
  };

  const saveAll = async () => {
    const pending = rows.filter((row) => dirtyKeys.includes(row.key));
    if (pending.length === 0) return;

    setSavingAll(true);
    setMessage(null);

    // Sequential on purpose: these are writes to the same two tables, and a
    // failure part-way through should leave a clear "these saved, this one
    // didn't" rather than an interleaved mess.
    const failures: string[] = [];
    for (const row of pending) {
      try {
        const error = await persistLine(row);
        if (error) failures.push(error);
      } catch {
        failures.push(`${lineName(row)}: unable to update right now.`);
      }
    }

    setSavingAll(false);
    const saved = pending.length - failures.length;
    setMessage(
      failures.length === 0
        ? `Saved ${saved} line${saved === 1 ? "" : "s"}.`
        : `Saved ${saved} of ${pending.length}. ${failures[0]}`,
    );
  };

  return (
    <section className="vl-panel rounded-2xl p-5 sm:p-6">
      {!inventoryTrackingActive ? (
        <div className="mb-4 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] px-4 py-3 text-sm text-cyan-100">
          <p className="font-semibold">Inventory enforcement is off</p>
          <p className="mt-1 text-cyan-100/80">
            These counts don&apos;t control the storefront yet — every product stays purchasable regardless of stock. Set real quantities below, then turn on &quot;Enforce inventory on the storefront&quot; in Settings to make them binding.
          </p>
          {rows.length > 0 ? (
            <p className="mt-2 text-cyan-100/80">
              {zeroCount === 0
                ? `All ${rows.length} line${rows.length === 1 ? "" : "s"} have a real count. Enforcement is safe to switch on.`
                : `${zeroCount} of ${rows.length} line${rows.length === 1 ? "" : "s"} ${zeroCount === 1 ? "is" : "are"} still at zero — those would come off the storefront the moment enforcement is enabled.`}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300">
        <p className="font-semibold text-zinc-100">Shipping weight</p>
        <p className="mt-1 text-zinc-400">
          The packed weight of <strong>one unit</strong> in ounces — vial, its immediate packaging, nothing else.
          It is multiplied by the quantity ordered and handed to Shippo as the basis for postage, so weigh a real one
          rather than guessing. Do <strong>not</strong> add the mailer&apos;s own weight here; that lives on the package
          in Settings and is counted once per parcel. Leave a variant blank to inherit its product&apos;s weight.
          {unweighedCount > 0 ? (
            <> <span className="text-amber-300/90">{unweighedCount} line{unweighedCount === 1 ? "" : "s"} still use an inherited or default weight.</span></>
          ) : null}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, variant, or SKU"
          className="vl-input min-w-0 flex-1 px-3 py-2 text-sm"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="vl-input px-3 py-2 text-sm">
          <option value="all">All lines</option>
          {inventoryTrackingActive ? <option value="low">Low stock</option> : null}
          {inventoryTrackingActive ? <option value="out">Out of stock</option> : null}
          <option value="unweighed">Not weighed yet</option>
        </select>
        {canManage ? (
          <button
            type="button"
            onClick={saveAll}
            disabled={savingAll || dirtyKeys.length === 0}
            className="vl-btn-primary px-4 py-2 text-sm disabled:opacity-40"
          >
            {savingAll ? "Saving…" : dirtyKeys.length > 0 ? `Save ${dirtyKeys.length} change${dirtyKeys.length === 1 ? "" : "s"}` : "No changes"}
          </button>
        ) : null}
      </div>

      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}

      {/* Mobile: one card per line. A six-column table on a phone is a
          horizontal-scroll trap, and this screen exists to be typed into. */}
      <div className="mt-4 space-y-3 lg:hidden">
        {filteredRows.map((row) => {
          const draft = draftFor(row);
          const dirty = dirtyKeys.includes(row.key);
          return (
            <div key={row.key} className={`rounded-xl border p-4 ${dirty ? "border-cyan-400/40 bg-cyan-400/[0.04]" : "border-white/10 bg-white/[0.02]"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">{lineName(row)}</p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{row.sku ?? row.productSlug}</p>
                </div>
                <StatusPill row={row} enforced={inventoryTrackingActive} />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Quantity
                  {canManage ? (
                    <input
                      inputMode="numeric"
                      value={draft.quantity}
                      onChange={(e) => setDraft(row.key, row, "quantity", e.target.value)}
                      className="vl-input mt-1 w-full px-3 py-2 text-sm"
                    />
                  ) : (
                    <p className="mt-1 text-sm text-zinc-200">{row.inventoryQuantity}</p>
                  )}
                </label>
                <label className="text-[11px] uppercase tracking-wide text-zinc-500">
                  Low-stock at
                  {canManage ? (
                    <input
                      inputMode="numeric"
                      value={draft.threshold}
                      onChange={(e) => setDraft(row.key, row, "threshold", e.target.value)}
                      className="vl-input mt-1 w-full px-3 py-2 text-sm"
                    />
                  ) : (
                    <p className="mt-1 text-sm text-zinc-200">{row.lowStockThreshold}</p>
                  )}
                </label>
                <label className="col-span-2 text-[11px] uppercase tracking-wide text-zinc-500">
                  Shipping weight (oz per unit)
                  {canManage ? (
                    <input
                      inputMode="decimal"
                      value={draft.weight}
                      onChange={(e) => setDraft(row.key, row, "weight", e.target.value)}
                      placeholder={String(row.effectiveShippingWeightOz)}
                      className="vl-input mt-1 w-full px-3 py-2 text-sm"
                    />
                  ) : (
                    <p className="mt-1 text-sm text-zinc-200">{row.effectiveShippingWeightOz} oz</p>
                  )}
                  <span className={`mt-1 block text-[11px] normal-case tracking-normal ${weightSourceClasses(row)}`}>
                    Uses {row.effectiveShippingWeightOz} oz · {weightSourceNote(row)}
                  </span>
                </label>
              </div>

              {canManage ? (
                <button
                  type="button"
                  onClick={() => saveLine(row)}
                  disabled={busyKey === row.key || savingAll}
                  className="vl-btn-secondary mt-3 w-full px-3 py-2 text-xs disabled:opacity-60"
                >
                  {busyKey === row.key ? "Saving…" : "Save line"}
                </button>
              ) : null}
            </div>
          );
        })}
        {filteredRows.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">No inventory lines match.</p>
        ) : null}
      </div>

      {/* Desktop: the dense table, which is what you want when entering counts
          for a whole catalog in one sitting. */}
      <div className="mt-4 hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[880px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="pb-2 pr-4">Product</th>
              <th className="pb-2 pr-4">SKU</th>
              <th className="pb-2 pr-4">Quantity</th>
              <th className="pb-2 pr-4">Low-stock threshold</th>
              <th className="pb-2 pr-4">Ship weight (oz/unit)</th>
              <th className="pb-2 pr-4">Status</th>
              {canManage ? <th className="pb-2 pr-4">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const draft = draftFor(row);
              const dirty = dirtyKeys.includes(row.key);
              return (
                <tr key={row.key} className={`border-t border-white/10 ${dirty ? "bg-cyan-400/[0.04]" : ""}`}>
                  <td className="py-3 pr-4 text-zinc-100">
                    {row.productName}
                    {row.variantLabel ? <span className="text-zinc-500"> — {row.variantLabel}</span> : null}
                  </td>
                  <td className="py-3 pr-4 text-zinc-400">{row.sku ?? "—"}</td>
                  <td className="py-3 pr-4">
                    {canManage ? (
                      <input
                        inputMode="numeric"
                        value={draft.quantity}
                        onChange={(e) => setDraft(row.key, row, "quantity", e.target.value)}
                        className="vl-input w-20 px-2 py-1 text-sm"
                      />
                    ) : row.inventoryQuantity}
                  </td>
                  <td className="py-3 pr-4">
                    {canManage ? (
                      <input
                        inputMode="numeric"
                        value={draft.threshold}
                        onChange={(e) => setDraft(row.key, row, "threshold", e.target.value)}
                        className="vl-input w-20 px-2 py-1 text-sm"
                      />
                    ) : row.lowStockThreshold}
                  </td>
                  <td className="py-3 pr-4">
                    {canManage ? (
                      <input
                        inputMode="decimal"
                        value={draft.weight}
                        onChange={(e) => setDraft(row.key, row, "weight", e.target.value)}
                        placeholder={String(row.effectiveShippingWeightOz)}
                        className="vl-input w-24 px-2 py-1 text-sm"
                      />
                    ) : `${row.effectiveShippingWeightOz} oz`}
                    <span className={`mt-1 block text-[11px] ${weightSourceClasses(row)}`}>
                      {row.effectiveShippingWeightOz} oz · {weightSourceNote(row)}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <StatusPill row={row} enforced={inventoryTrackingActive} />
                  </td>
                  {canManage ? (
                    <td className="py-3 pr-4">
                      <button
                        type="button"
                        onClick={() => saveLine(row)}
                        disabled={busyKey === row.key || savingAll}
                        className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        Save
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 7 : 6} className="py-6 text-center text-sm text-zinc-500">No inventory lines match.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
