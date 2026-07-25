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

type EffectiveStatus = "active" | "scheduled" | "expired" | "limit" | "disabled";

// The real, usable state of a coupon — not just its on/off flag. A coupon can be
// switched "on" yet still not apply (not started, expired, or maxed out); this is
// what determines whether it discounts an order at checkout.
function effectiveStatus(coupon: AdminCoupon): EffectiveStatus {
  if (!coupon.active) return "disabled";
  const now = Date.now();
  if (coupon.startsAt && new Date(coupon.startsAt).getTime() > now) return "scheduled";
  if (coupon.endsAt && new Date(coupon.endsAt).getTime() < now) return "expired";
  if (coupon.maxRedemptions != null && coupon.redemptionsCount >= coupon.maxRedemptions) return "limit";
  return "active";
}

const STATUS_META: Record<EffectiveStatus, { label: string; className: string }> = {
  active: { label: "Live", className: "bg-emerald-400/15 text-emerald-300" },
  scheduled: { label: "Scheduled", className: "bg-amber-400/15 text-amber-300" },
  expired: { label: "Expired", className: "bg-zinc-500/15 text-zinc-400" },
  limit: { label: "Limit reached", className: "bg-orange-400/15 text-orange-300" },
  disabled: { label: "Disabled", className: "bg-zinc-500/15 text-zinc-400" },
};

function fromDatetimeLocal(value: string) {
  if (!value.trim()) return null;
  return new Date(value).toISOString();
}

export function AdminCouponsClient({
  initialCoupons,
  recoveryCoupons = [],
  recoveryTotal = 0,
}: {
  initialCoupons: AdminCoupon[];
  recoveryCoupons?: AdminCoupon[];
  recoveryTotal?: number;
}) {
  const [coupons, setCoupons] = useState<AdminCoupon[]>(initialCoupons);
  const [form, setForm] = useState<CouponFormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRecovery, setShowRecovery] = useState(false);

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

      {coupons.length === 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <p className="py-6 text-center text-sm text-zinc-500">No coupons yet. Create one above.</p>
        </section>
      ) : (
        COUPON_GROUPS.map((group) => {
          const items = coupons.filter((coupon) => group.match.includes(effectiveStatus(coupon)));
          return (
            <section key={group.key} className="vl-panel rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h2 className="text-lg font-semibold text-white">{group.title} ({items.length})</h2>
                <span className="text-xs text-zinc-500">{group.hint}</span>
              </div>
              {items.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-500">None.</p>
              ) : (
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
                      {items.map((coupon) => {
                        const status = STATUS_META[effectiveStatus(coupon)];
                        return (
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
                              <span className={`rounded-full px-2 py-1 text-xs ${status.className}`}>{status.label}</span>
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
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}

      {recoveryTotal > 0 ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <button
            type="button"
            onClick={() => setShowRecovery((v) => !v)}
            className="flex w-full flex-wrap items-baseline justify-between gap-x-3 text-left"
            aria-expanded={showRecovery}
          >
            <h2 className="text-lg font-semibold text-white">
              <span className="mr-2 text-zinc-500">{showRecovery ? "▾" : "▸"}</span>
              Cart-recovery codes ({recoveryTotal})
            </h2>
            <span className="text-xs text-zinc-500">Auto-generated for abandoned carts — managed for you</span>
          </button>

          {showRecovery ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2 pr-4">Code</th>
                    <th className="pb-2 pr-4">Discount</th>
                    <th className="pb-2 pr-4">Sent to</th>
                    <th className="pb-2 pr-4">Created</th>
                    <th className="pb-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recoveryCoupons.map((coupon) => {
                    const status = STATUS_META[effectiveStatus(coupon)];
                    return (
                      <tr key={coupon.id} className="border-t border-white/10">
                        <td className="py-3 pr-4 font-mono text-zinc-100">{coupon.code}</td>
                        <td className="py-3 pr-4 text-zinc-300">{formatDiscount(coupon)}</td>
                        <td className="py-3 pr-4 text-xs text-zinc-400">{coupon.assignedEmail ?? "—"}</td>
                        <td className="py-3 pr-4 text-xs text-zinc-400">{new Date(coupon.createdAt).toLocaleDateString()}</td>
                        <td className="py-3 pr-4">
                          <span className={`rounded-full px-2 py-1 text-xs ${status.className}`}>{status.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {recoveryTotal > recoveryCoupons.length ? (
                <p className="mt-3 text-xs text-zinc-500">Showing the most recent {recoveryCoupons.length} of {recoveryTotal}. These are created automatically when a shopper abandons a cart — you don&apos;t need to manage them.</p>
              ) : (
                <p className="mt-3 text-xs text-zinc-500">These are created automatically when a shopper abandons a cart — you don&apos;t need to manage them.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const COUPON_GROUPS: { key: string; title: string; hint: string; match: EffectiveStatus[] }[] = [
  { key: "live", title: "Live now", hint: "Working at checkout right now", match: ["active"] },
  { key: "scheduled", title: "Scheduled", hint: "Turned on, waiting to start", match: ["scheduled"] },
  { key: "inactive", title: "Not running", hint: "Disabled, expired, or maxed out", match: ["expired", "limit", "disabled"] },
];
