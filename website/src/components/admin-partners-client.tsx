"use client";

import { useMemo, useState } from "react";
import type { AdminPartnerRow } from "@/lib/partner-portal";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function AdminPartnersClient({ initialRows }: { initialRows: AdminPartnerRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [payoutStatus, setPayoutStatus] = useState("all");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCommission, setInviteCommission] = useState("10");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const liveSales = useMemo(() => rows.reduce((sum, row) => sum + row.totalRevenue, 0), [rows]);
  const paidCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.paidCommissions, 0), [rows]);
  const approvedForPayoutCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.approvedForPayoutCommissions, 0), [rows]);
  const reversedCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.reversedCommissions, 0), [rows]);
  const pendingCommissions = useMemo(() => rows.reduce((sum, row) => sum + row.pendingCommissions, 0), [rows]);

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
                  </td>
                  <td className="px-2 py-2">{row.clicks}</td>
                  <td className="px-2 py-2">{row.conversionRate.toFixed(2)}%</td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => applyPartnerAction(row.id, { action: "set_status", status: "approved" })}
                        className="rounded border border-emerald-400/35 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200"
                      >Approve</button>
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
                          const input = window.prompt("Set commission percentage", row.commissionPercent.toString());
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
                      <button
                        type="button"
                        disabled={loading || row.approvedForPayoutCommissions <= 0}
                        onClick={() => applyPartnerAction(row.id, { action: "mark_paid", amount: row.approvedForPayoutCommissions, note: "Bulk payout" })}
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
    </div>
  );
}
