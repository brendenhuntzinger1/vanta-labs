"use client";

import { useMemo, useState } from "react";
import type { AdminPartnerRow } from "@/lib/partner-portal";
import type { CommissionTierRule } from "@/lib/ambassador-commission";
import type { AmbassadorProgramSettings } from "@/lib/ambassador-settings";
import type { FraudReviewRow, PayoutHistoryRow } from "@/lib/admin-ambassadors";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function AdminPartnersClient({
  initialRows,
  initialTiers,
  initialSettings,
  initialFraudRows,
  initialPayoutHistory,
}: {
  initialRows: AdminPartnerRow[];
  initialTiers: CommissionTierRule[];
  initialSettings: AmbassadorProgramSettings;
  initialFraudRows: FraudReviewRow[];
  initialPayoutHistory: PayoutHistoryRow[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [tiers, setTiers] = useState(initialTiers);
  const [settings, setSettings] = useState(initialSettings);
  const [fraudRows, setFraudRows] = useState(initialFraudRows);
  const [payoutHistory, setPayoutHistory] = useState(initialPayoutHistory);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [payoutStatus, setPayoutStatus] = useState("all");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCommission, setInviteCommission] = useState("10");
  const [newTierName, setNewTierName] = useState("");
  const [newTierMinSales, setNewTierMinSales] = useState("0");
  const [newTierPercent, setNewTierPercent] = useState("10");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const liveSales = useMemo(() => rows.reduce((sum, row) => sum + row.totalRevenue, 0), [rows]);
  const paidCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.paidCommissions, 0), [rows]);
  const approvedForPayoutCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.approvedForPayoutCommissions, 0), [rows]);
  const reversedCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.reversedCommissions, 0), [rows]);
  const pendingCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.pendingCommissions, 0), [rows]);

  const topPerformers = useMemo(
    () => [...rows]
      .filter((row) => row.totalRevenue > 0 || row.paidCommissions > 0)
      .sort((a, b) => (b.totalRevenue + b.paidCommissions) - (a.totalRevenue + a.paidCommissions))
      .slice(0, 5),
    [rows],
  );

  const filteredRows = useMemo(() => rows.filter((row) => {
    const statusMatch = status === "all" || row.status === status;
    const q = search.trim().toLowerCase();
    if (!q) return statusMatch;
    return statusMatch && (
      row.name.toLowerCase().includes(q)
      || (row.email ?? "").toLowerCase().includes(q)
      || row.referralCode.toLowerCase().includes(q)
    );
  }), [rows, search, status]);

  const refreshRows = async () => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (payoutStatus !== "all") params.set("payoutStatus", payoutStatus);
    if (search.trim()) params.set("search", search.trim());

    const response = await fetch(`/api/admin/partners?${params.toString()}`);
    const json = await response.json();
    if (!response.ok || !json.success) {
      throw new Error(json.error ?? "Unable to refresh partners");
    }

    setRows(json.rows);
  };

  const refreshFraudAndPayouts = async () => {
    const [fraudResponse, payoutResponse] = await Promise.all([
      fetch("/api/admin/ambassadors/fraud"),
      fetch("/api/admin/ambassadors/payouts"),
    ]);
    const fraudJson = await fraudResponse.json();
    const payoutJson = await payoutResponse.json();
    if (fraudResponse.ok && fraudJson.success) setFraudRows(fraudJson.rows);
    if (payoutResponse.ok && payoutJson.success) setPayoutHistory(payoutJson.rows);
  };

  const applyPartnerAction = async (partnerId: string, payload: Record<string, unknown>) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/partners/${partnerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Action failed");
      }
      await refreshRows();
      await refreshFraudAndPayouts();
      setMessage("Partner updated successfully.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed");
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: inviteName,
          email: inviteEmail,
          commissionPercent: Number(inviteCommission),
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to send invite");
      }

      setInviteName("");
      setInviteEmail("");
      setInviteCommission("10");
      await refreshRows();
      setMessage("Partner invite sent and profile created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send invite");
    } finally {
      setLoading(false);
    }
  };

  const handleMarkPaid = async (row: AdminPartnerRow) => {
    let overrideMinimumThreshold = false;
    if (row.approvedForPayoutCommissions < settings.minimumPayoutThreshold) {
      const confirmed = window.confirm(
        `${currency(row.approvedForPayoutCommissions)} is below the ${currency(settings.minimumPayoutThreshold)} minimum payout threshold. Pay out anyway?`,
      );
      if (!confirmed) return;
      overrideMinimumThreshold = true;
    }

    await applyPartnerAction(row.id, {
      action: "mark_paid",
      amount: row.approvedForPayoutCommissions,
      note: "Bulk payout",
      overrideMinimumThreshold,
    });
  };

  const handleCreateTier = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ambassadors/tiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newTierName,
          minMonthlySales: Number(newTierMinSales),
          commissionPercent: Number(newTierPercent),
          position: tiers.length,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to create tier");
      }
      setTiers(json.tiers);
      setNewTierName("");
      setNewTierMinSales("0");
      setNewTierPercent("10");
      setMessage("Commission tier created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create tier");
    } finally {
      setLoading(false);
    }
  };

  const updateTier = async (tierId: string, payload: Record<string, unknown>) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ambassadors/tiers/${tierId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to update tier");
      }
      setTiers(json.tiers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update tier");
    } finally {
      setLoading(false);
    }
  };

  const deleteTier = async (tierId: string) => {
    if (!window.confirm("Delete this commission tier rule?")) return;
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/ambassadors/tiers/${tierId}`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to delete tier");
      }
      setTiers(json.tiers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete tier");
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = async (key: "minimum_qualifying_order" | "minimum_payout_threshold" | "commission_hold_days", value: number) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ambassadors/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to update setting");
      }
      setSettings(json.settings);
      setMessage("Ambassador program setting updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update setting");
    } finally {
      setLoading(false);
    }
  };

  const clearFraudFlag = async (referralOrderId: string) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ambassadors/fraud", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referralOrderId }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to clear flag");
      }
      setFraudRows(json.rows);
      setMessage("Flag cleared.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to clear flag");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Live Sales</p>
          <p className="mt-2 text-2xl font-semibold text-white">{currency(liveSales)}</p>
        </div>
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Pending Commissions</p>
          <p className="mt-2 text-2xl font-semibold text-white">{currency(pendingCommissions)}</p>
        </div>
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Paid Commissions</p>
          <p className="mt-2 text-2xl font-semibold text-white">{currency(paidCommissions)}</p>
        </div>
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Approved For Payout</p>
          <p className="mt-2 text-2xl font-semibold text-white">{currency(approvedForPayoutCommissions)}</p>
        </div>
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Reversed Commissions</p>
          <p className="mt-2 text-2xl font-semibold text-white">{currency(reversedCommissions)}</p>
        </div>
        <div className="vl-panel rounded-2xl p-4">
          <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Active Partners</p>
          <p className="mt-2 text-2xl font-semibold text-white">{rows.filter((row) => row.status === "approved").length}</p>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Top Performers</h2>
        {topPerformers.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No sales recorded yet.</p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {topPerformers.map((row, index) => (
              <div key={row.id} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
                <p className="text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">#{index + 1}</p>
                <p className="mt-1 truncate text-sm font-semibold text-white">{row.name}</p>
                <p className="mt-1 text-xs text-zinc-400">{currency(row.totalRevenue)} revenue</p>
                <p className="text-xs text-zinc-500">{currency(row.paidCommissions)} paid</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Fraud &amp; Review</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Orders flagged for repeat address/email abuse, below the minimum qualifying order, or with a refund received after commission payout. Flags never block a sale - only whether it earns a commission automatically.
        </p>
        {fraudRows.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">Nothing flagged for review.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-2">Ambassador</th>
                  <th className="px-2 py-2">Order</th>
                  <th className="px-2 py-2">Commission</th>
                  <th className="px-2 py-2">Reason</th>
                  <th className="px-2 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {fraudRows.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2">{row.ambassadorName}</td>
                    <td className="px-2 py-2 text-xs text-zinc-400">{row.orderId}</td>
                    <td className="px-2 py-2">{currency(row.commissionAmount)}</td>
                    <td className="px-2 py-2 max-w-xs text-xs text-amber-200">{row.fraudReason ?? row.ineligibleReason ?? "Refund received after commission payment"}</td>
                    <td className="px-2 py-2">
                      {row.fraudFlag ? (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => clearFraudFlag(row.id)}
                          className="rounded border border-emerald-400/35 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200"
                        >Clear flag</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Commission Tiers</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Applied automatically based on each ambassador&apos;s qualifying paid, non-refunded orders this calendar month - unless a partner has a manually locked commission percent.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-2">Name</th>
                <th className="px-2 py-2">Min monthly sales</th>
                <th className="px-2 py-2">Commission %</th>
                <th className="px-2 py-2">Active</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id} className="border-t border-zinc-800/70 text-zinc-200">
                  <td className="px-2 py-2">
                    <input
                      defaultValue={tier.name}
                      onBlur={(event) => event.target.value !== tier.name && updateTier(tier.id, { name: event.target.value })}
                      className="vl-input w-32 px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      min={0}
                      defaultValue={tier.minMonthlySales}
                      onBlur={(event) => Number(event.target.value) !== tier.minMonthlySales && updateTier(tier.id, { minMonthlySales: Number(event.target.value) })}
                      className="vl-input w-24 px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      defaultValue={tier.commissionPercent}
                      onBlur={(event) => Number(event.target.value) !== tier.commissionPercent && updateTier(tier.id, { commissionPercent: Number(event.target.value) })}
                      className="vl-input w-20 px-2 py-1 text-xs"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={tier.isActive}
                      onChange={(event) => updateTier(tier.id, { isActive: event.target.checked })}
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => deleteTier(tier.id)}
                      className="rounded border border-rose-400/35 bg-rose-500/10 px-2 py-1 text-xs text-rose-200"
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form className="mt-4 grid gap-3 sm:grid-cols-4" onSubmit={handleCreateTier}>
          <input value={newTierName} onChange={(event) => setNewTierName(event.target.value)} placeholder="Tier name" className="vl-input px-3 py-2 text-sm" required />
          <input type="number" min={0} value={newTierMinSales} onChange={(event) => setNewTierMinSales(event.target.value)} placeholder="Min monthly sales" className="vl-input px-3 py-2 text-sm" />
          <input type="number" min={0} max={100} step={0.5} value={newTierPercent} onChange={(event) => setNewTierPercent(event.target.value)} placeholder="Commission %" className="vl-input px-3 py-2 text-sm" />
          <button type="submit" disabled={loading} className="vl-focus-ring rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-4 py-2 text-sm font-semibold text-zinc-950">
            Add Tier
          </button>
        </form>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Ambassador Program Settings</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="text-sm text-zinc-300">
            <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Minimum qualifying order</span>
            <input
              type="number"
              min={0}
              defaultValue={settings.minimumQualifyingOrder}
              onBlur={(event) => Number(event.target.value) !== settings.minimumQualifyingOrder && updateSetting("minimum_qualifying_order", Number(event.target.value))}
              className="vl-input w-full px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-zinc-500">Referral codes require at least this merchandise subtotal.</span>
          </label>
          <label className="text-sm text-zinc-300">
            <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Minimum payout threshold</span>
            <input
              type="number"
              min={0}
              defaultValue={settings.minimumPayoutThreshold}
              onBlur={(event) => Number(event.target.value) !== settings.minimumPayoutThreshold && updateSetting("minimum_payout_threshold", Number(event.target.value))}
              className="vl-input w-full px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-zinc-500">Payouts below this amount require an explicit override.</span>
          </label>
          <label className="text-sm text-zinc-300">
            <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">Commission hold period (days)</span>
            <input
              type="number"
              min={0}
              defaultValue={settings.commissionHoldDays}
              onBlur={(event) => Number(event.target.value) !== settings.commissionHoldDays && updateSetting("commission_hold_days", Number(event.target.value))}
              className="vl-input w-full px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-zinc-500">Waiting period before a paid, non-refunded order&apos;s commission is eligible for payout.</span>
          </label>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Invite Partner</h2>
        <form className="mt-4 grid gap-3 sm:grid-cols-4" onSubmit={handleInvite}>
          <input
            value={inviteName}
            onChange={(event) => setInviteName(event.target.value)}
            placeholder="Partner name"
            className="vl-input px-3 py-2 text-sm"
            required
          />
          <input
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="email@domain.com"
            className="vl-input px-3 py-2 text-sm"
            required
          />
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={inviteCommission}
            onChange={(event) => setInviteCommission(event.target.value)}
            placeholder="Commission %"
            className="vl-input px-3 py-2 text-sm"
          />
          <button type="submit" disabled={loading} className="vl-focus-ring rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-4 py-2 text-sm font-semibold text-zinc-950">
            Invite
          </button>
        </form>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search partner, email, code"
            className="vl-input flex-1 px-3 py-2 text-sm"
          />
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="vl-input px-3 py-2 text-sm sm:w-40">
            <option value="all">All statuses</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="info_requested">Info Requested</option>
            <option value="rejected">Rejected</option>
            <option value="disabled">Disabled</option>
          </select>
          <select value={payoutStatus} onChange={(event) => setPayoutStatus(event.target.value)} className="vl-input px-3 py-2 text-sm sm:w-52">
            <option value="all">All payout statuses</option>
            <option value="pending">Pending</option>
            <option value="approved_for_payout">Approved for payout</option>
            <option value="paid">Paid</option>
            <option value="reversed">Reversed</option>
          </select>
          <button type="button" onClick={refreshRows} className="vl-btn-secondary px-4 py-2 text-sm">Refresh</button>
          <button
            type="button"
            onClick={() => {
              const params = new URLSearchParams();
              if (payoutStatus !== "all") {
                params.set("payoutStatus", payoutStatus);
              }
              const query = params.toString();
              window.location.href = `/api/admin/partners/export-payouts${query ? `?${query}` : ""}`;
            }}
            className="vl-btn-secondary px-4 py-2 text-sm text-center"
          >
            Export CSV
          </button>
        </div>

        {message ? <p className="mt-3 text-sm text-cyan-200">{message}</p> : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-2">Partner</th>
                <th className="px-2 py-2">Code</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Revenue</th>
                <th className="px-2 py-2">Commission</th>
                <th className="px-2 py-2">Clicks</th>
                <th className="px-2 py-2">Conv %</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                  <td className="px-2 py-2">
                    <p className="font-semibold text-white">{row.name}</p>
                    <p className="text-xs text-zinc-500">{row.email ?? "-"}</p>
                  </td>
                  <td className="px-2 py-2">{row.referralCode}</td>
                  <td className="px-2 py-2">{row.status}</td>
                  <td className="px-2 py-2">{currency(row.totalRevenue)}</td>
                  <td className="px-2 py-2">
                    <p>{currency(row.pendingCommissions)} pending</p>
                    <p className="text-xs text-zinc-500">{currency(row.approvedForPayoutCommissions)} approved</p>
                    <p className="text-xs text-zinc-500">{currency(row.paidCommissions)} paid</p>
                    <p className="text-xs text-zinc-500">{currency(row.reversedCommissions)} reversed</p>
                    <p className="mt-1 text-xs">
                      {row.commissionPercentLocked ? (
                        <span className="text-amber-300">{row.commissionPercent}% (manual)</span>
                      ) : (
                        <span className="text-emerald-300">Auto tiers active</span>
                      )}
                    </p>
                  </td>
                  <td className="px-2 py-2">{row.clicks}</td>
                  <td className="px-2 py-2">{row.conversionRate.toFixed(2)}%</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          const input = window.prompt("Set referral code (leave blank to keep current)", row.referralCode);
                          if (input === null) return;
                          const nextCode = input.trim();
                          applyPartnerAction(row.id, {
                            action: "set_status",
                            status: "approved",
                            referralCode: nextCode || row.referralCode,
                          });
                        }}
                        className="rounded border border-emerald-400/35 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200"
                      >Approve</button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => applyPartnerAction(row.id, { action: "set_status", status: "info_requested" })}
                        className="rounded border border-sky-400/35 bg-sky-500/10 px-2 py-1 text-xs text-sky-200"
                      >Request Info</button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => applyPartnerAction(row.id, { action: "set_status", status: "disabled" })}
                        className="rounded border border-rose-400/35 bg-rose-500/10 px-2 py-1 text-xs text-rose-200"
                      >Disable</button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => applyPartnerAction(row.id, { action: "set_status", status: "rejected" })}
                        className="rounded border border-amber-400/35 bg-amber-500/10 px-2 py-1 text-xs text-amber-200"
                      >Reject</button>
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          const input = window.prompt("Set commission percentage (locks this ambassador out of automatic performance tiers)", row.commissionPercent.toString());
                          if (input === null) return;
                          const value = Number(input);
                          if (!Number.isFinite(value) || value < 0 || value > 100) {
                            setMessage("Commission must be between 0 and 100.");
                            return;
                          }
                          applyPartnerAction(row.id, {
                            action: "set_status",
                            status: row.status,
                            commissionPercent: value,
                          });
                        }}
                        className="rounded border border-violet-400/35 bg-violet-500/10 px-2 py-1 text-xs text-violet-200"
                      >Set %</button>
                      {row.commissionPercentLocked ? (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => applyPartnerAction(row.id, { action: "set_status", status: row.status, commissionPercentLocked: false })}
                          className="rounded border border-cyan-400/35 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100"
                        >Enable Auto Tiers</button>
                      ) : null}
                      <button
                        type="button"
                        disabled={loading || row.approvedForPayoutCommissions <= 0}
                        onClick={() => handleMarkPaid(row)}
                        className="rounded border border-cyan-400/35 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-100 disabled:opacity-50"
                      >Mark Paid</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Payout History</h2>
        {payoutHistory.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No payouts recorded yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-2">Ambassador</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Note</th>
                  <th className="px-2 py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {payoutHistory.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2">{row.ambassadorName}</td>
                    <td className="px-2 py-2">{currency(row.amount)}</td>
                    <td className="px-2 py-2 text-xs text-zinc-400">{row.note ?? "-"}</td>
                    <td className="px-2 py-2 text-xs text-zinc-500">{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
