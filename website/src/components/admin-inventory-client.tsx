"use client";

import { useMemo, useState } from "react";
import type { InventoryLine } from "@/lib/admin-inventory";

type StatusFilter = "all" | "low" | "out";

export function AdminInventoryClient({ initialRows, canManage }: { initialRows: InventoryLine[]; canManage: boolean }) {
  const [rows, setRows] = useState<InventoryLine[]>(initialRows);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [drafts, setDrafts] = useState<Record<string, { quantity: string; threshold: string }>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter === "low" && !row.isLowStock) return false;
      if (statusFilter === "out" && !row.isOutOfStock) return false;
      if (!term) return true;
      return row.productName.toLowerCase().includes(term)
        || row.productSlug.toLowerCase().includes(term)
        || (row.sku ?? "").toLowerCase().includes(term)
        || (row.variantLabel ?? "").toLowerCase().includes(term);
    });
  }, [rows, search, statusFilter]);

  const draftFor = (row: InventoryLine) => drafts[row.key] ?? { quantity: String(row.inventoryQuantity), threshold: String(row.lowStockThreshold) };

  const setDraft = (key: string, field: "quantity" | "threshold", value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? { quantity: "", threshold: "" }), [field]: value },
    }));
  };

  const saveLine = async (row: InventoryLine) => {
    const draft = draftFor(row);
    const quantity = Number(draft.quantity);
    const threshold = Number(draft.threshold);

    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(threshold) || threshold < 0) {
      setMessage("Enter valid non-negative numbers for quantity and threshold.");
      return;
    }

    setBusyKey(row.key);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: row.productId,
          doseId: row.doseId,
          quantity,
          lowStockThreshold: threshold,
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to update inventory.");
        return;
      }

      setRows((prev) => prev.map((line) => (line.key === row.key
        ? { ...line, inventoryQuantity: quantity, lowStockThreshold: threshold, isOutOfStock: quantity <= 0, isLowStock: quantity > 0 && quantity <= threshold }
        : line)));
      setMessage(`Updated ${row.productName}${row.variantLabel ? ` (${row.variantLabel})` : ""}.`);
    } catch {
      setMessage("Unable to update inventory right now.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="vl-panel rounded-2xl p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search product, variant, or SKU"
          className="vl-input flex-1 px-3 py-2 text-sm"
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="vl-input px-3 py-2 text-sm">
          <option value="all">All lines</option>
          <option value="low">Low stock</option>
          <option value="out">Out of stock</option>
        </select>
      </div>

      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="pb-2 pr-4">Product</th>
              <th className="pb-2 pr-4">SKU</th>
              <th className="pb-2 pr-4">Quantity</th>
              <th className="pb-2 pr-4">Low-stock threshold</th>
              <th className="pb-2 pr-4">Status</th>
              {canManage ? <th className="pb-2 pr-4">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const draft = draftFor(row);
              return (
                <tr key={row.key} className="border-t border-white/10">
                  <td className="py-3 pr-4 text-zinc-100">
                    {row.productName}
                    {row.variantLabel ? <span className="text-zinc-500"> — {row.variantLabel}</span> : null}
                  </td>
                  <td className="py-3 pr-4 text-zinc-400">{row.sku ?? "—"}</td>
                  <td className="py-3 pr-4">
                    {canManage ? (
                      <input
                        value={draft.quantity}
                        onChange={(e) => setDraft(row.key, "quantity", e.target.value)}
                        className="vl-input w-20 px-2 py-1 text-sm"
                      />
                    ) : row.inventoryQuantity}
                  </td>
                  <td className="py-3 pr-4">
                    {canManage ? (
                      <input
                        value={draft.threshold}
                        onChange={(e) => setDraft(row.key, "threshold", e.target.value)}
                        className="vl-input w-20 px-2 py-1 text-sm"
                      />
                    ) : row.lowStockThreshold}
                  </td>
                  <td className="py-3 pr-4">
                    {row.isOutOfStock ? (
                      <span className="rounded-full bg-rose-500/15 px-2 py-1 text-xs text-rose-300">Out of stock</span>
                    ) : row.isLowStock ? (
                      <span className="rounded-full bg-amber-400/15 px-2 py-1 text-xs text-amber-300">Low stock</span>
                    ) : (
                      <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300">In stock</span>
                    )}
                  </td>
                  {canManage ? (
                    <td className="py-3 pr-4">
                      <button
                        type="button"
                        onClick={() => saveLine(row)}
                        disabled={busyKey === row.key}
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
                <td colSpan={canManage ? 6 : 5} className="py-6 text-center text-sm text-zinc-500">No inventory lines match.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
