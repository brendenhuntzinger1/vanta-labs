"use client";

import { useState } from "react";
import type { AdminCoupon } from "@/lib/admin-coupons";

type CouponFormState = {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: string;
  startsAt: string;
  endsAt: string;
  maxRedemptions: string;
};

const EMPTY_FORM: CouponFormState = {
  code: "",
  discountType: "percent",
  discountValue: "",
  startsAt: "",
  endsAt: "",
  maxRedemptions: "",
};

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatDiscount(coupon: AdminCoupon) {
  return coupon.discountType === "fixed" ? currency(coupon.discountValue) : `${coupon.discountValue}%`;
}

function fromDatetimeLocal(value: string) {
  if (!value.trim()) return null;
  return new Date(value).toISOString();
}

export function AdminCouponsClient({ initialCoupons }: { initialCoupons: AdminCoupon[] }) {
  const [coupons, setCoupons] = useState<AdminCoupon[]>(initialCoupons);
  const [form, setForm] = useState<CouponFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    const response = await fetch("/api/admin/coupons");
    const result = await response.json() as { success: boolean; coupons?: AdminCoupon[] };
    if (result.success && result.coupons) {
      setCoupons(result.coupons);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setMessage(null);

    const discountValue = Number(form.discountValue);
    if (!form.code.trim() || !Number.isFinite(discountValue) || discountValue <= 0) {
      setError("Enter a code and a positive discount value.");
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code,
          discountType: form.discountType,
          discountValue,
          startsAt: fromDatetimeLocal(form.startsAt),
          endsAt: fromDatetimeLocal(form.endsAt),
          maxRedemptions: form.maxRedemptions.trim() ? Number(form.maxRedemptions) : null,
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to create coupon.");
        return;
      }
      setMessage(`Coupon "${form.code.trim().toUpperCase()}" created.`);
      setForm(EMPTY_FORM);
      await refresh();
    } catch {
      setError("Unable to create coupon right now.");
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (coupon: AdminCoupon) => {
    setBusyId(coupon.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/coupons/${coupon.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !coupon.active }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to update coupon.");
        return;
      }
      await refresh();
    } catch {
      setError("Unable to update coupon right now.");
    } finally {
      setBusyId(null);
    }
  };

  const handleAnnounce = async (coupon: AdminCoupon) => {
    const headline = window.prompt(
      `Email all customers who opted into marketing about coupon "${coupon.code}".\n\nSubject/headline for the email:`,
      `New offer: ${coupon.discountType === "fixed" ? `$${coupon.discountValue} off` : `${coupon.discountValue}% off`}`,
    );
    if (headline === null) return;
    const messageText = window.prompt("Optional short message to include (leave blank to skip):", "") ?? "";

    setBusyId(coupon.id);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/coupons/${coupon.id}/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: headline.trim(), message: messageText.trim() }),
      });
      const result = await response.json() as { success: boolean; error?: string; sent?: number; recipients?: number; skipped?: number; failed?: number };
      if (!result.success) {
        setError(result.error ?? "Unable to send announcement.");
        return;
      }
      setMessage(`Announcement sent: ${result.sent ?? 0} emailed of ${result.recipients ?? 0} opted-in customers (${result.skipped ?? 0} skipped, ${result.failed ?? 0} failed).`);
    } catch {
      setError("Unable to send announcement right now.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (coupon: AdminCoupon) => {
    if (!window.confirm(`Delete coupon "${coupon.code}"? This cannot be undone.`)) {
      return;
    }

    setBusyId(coupon.id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/coupons/${coupon.id}`, { method: "DELETE" });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to delete coupon.");
        return;
      }
      setMessage(`Coupon "${coupon.code}" deleted.`);
      await refresh();
    } catch {
      setError("Unable to delete coupon right now.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">New coupon</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm text-zinc-300">
            Code
            <input
              value={form.code}
              onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value }))}
              placeholder="SAVE10"
              className="vl-input mt-1 w-full px-3 py-2"
            />
          </label>
          <label className="text-sm text-zinc-300">
            Discount type
            <select
              value={form.discountType}
              onChange={(e) => setForm((prev) => ({ ...prev, discountType: e.target.value as "percent" | "fixed" }))}
              className="vl-input mt-1 w-full px-3 py-2"
            >
              <option value="percent">Percent off</option>
              <option value="fixed">Fixed amount off</option>
            </select>
          </label>
          <label className="text-sm text-zinc-300">
            Discount value
            <input
              value={form.discountValue}
              onChange={(e) => setForm((prev) => ({ ...prev, discountValue: e.target.value }))}
              placeholder={form.discountType === "fixed" ? "15.00" : "10"}
              className="vl-input mt-1 w-full px-3 py-2"
            />
          </label>
          <label className="text-sm text-zinc-300">
            Starts at (optional)
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm((prev) => ({ ...prev, startsAt: e.target.value }))}
              className="vl-input mt-1 w-full px-3 py-2"
            />
          </label>
          <label className="text-sm text-zinc-300">
            Ends at (optional)
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm((prev) => ({ ...prev, endsAt: e.target.value }))}
              className="vl-input mt-1 w-full px-3 py-2"
            />
          </label>
          <label className="text-sm text-zinc-300">
            Max redemptions (optional)
            <input
              value={form.maxRedemptions}
              onChange={(e) => setForm((prev) => ({ ...prev, maxRedemptions: e.target.value }))}
              placeholder="Unlimited"
              className="vl-input mt-1 w-full px-3 py-2"
            />
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60"
        >
          {creating ? "Creating…" : "Create coupon"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">All coupons ({coupons.length})</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="pb-2 pr-4">Code</th>
                <th className="pb-2 pr-4">Discount</th>
                <th className="pb-2 pr-4">Window</th>
                <th className="pb-2 pr-4">Redemptions</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => (
                <tr key={coupon.id} className="border-t border-white/10">
                  <td className="py-3 pr-4 font-mono text-zinc-100">{coupon.code}</td>
                  <td className="py-3 pr-4 text-zinc-300">{formatDiscount(coupon)}</td>
                  <td className="py-3 pr-4 text-xs text-zinc-400">
                    {coupon.startsAt ? new Date(coupon.startsAt).toLocaleDateString() : "—"}
                    {" → "}
                    {coupon.endsAt ? new Date(coupon.endsAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="py-3 pr-4 text-zinc-300">
                    {coupon.redemptionsCount}{coupon.maxRedemptions ? ` / ${coupon.maxRedemptions}` : ""}
                  </td>
                  <td className="py-3 pr-4">
                    <span className={coupon.active ? "rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300" : "rounded-full bg-zinc-500/15 px-2 py-1 text-xs text-zinc-400"}>
                      {coupon.active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => toggleActive(coupon)}
                        disabled={busyId === coupon.id}
                        className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        {coupon.active ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAnnounce(coupon)}
                        disabled={busyId === coupon.id}
                        className="vl-btn-secondary px-3 py-1.5 text-xs text-cyan-200 disabled:opacity-60"
                        title="Email all opted-in customers about this coupon"
                      >
                        Email customers
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(coupon)}
                        disabled={busyId === coupon.id}
                        className="vl-btn-secondary px-3 py-1.5 text-xs text-rose-300 disabled:opacity-60"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {coupons.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-sm text-zinc-500">No coupons yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
