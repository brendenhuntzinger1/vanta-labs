"use client";

import { useMemo, useState } from "react";
import type { AdminPartnerRow } from "@/lib/partner-portal";
import type { CommissionTierRule } from "@/lib/ambassador-commission";
import type { AmbassadorMarketingResource, AmbassadorProgramSettings } from "@/lib/ambassador-settings";
import type { FraudReviewRow, PayoutHistoryRow } from "@/lib/admin-ambassadors";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// The admin surface, grouped by the question being asked rather than by which
// table the data came from. Every section already existed; they were simply all
// stacked on one scroll, so finding the payout history meant passing the
// commission tier editor.
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "ambassadors", label: "Ambassadors" },
  { key: "applications", label: "Applications" },
  { key: "payouts", label: "Payouts" },
  { key: "program", label: "Program" },
  { key: "analytics", label: "Analytics" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// The three program settings, described once. Each carries the control-table
// key it persists under and the resolved-settings property it reads back from.
const PROGRAM_SETTING_FIELDS = [
  {
    key: "minimum_qualifying_order",
    prop: "minimumQualifyingOrder",
    label: "Minimum qualifying order",
    help: "Referral codes require at least this PRE-discount merchandise subtotal to earn commission.",
  },
  {
    key: "minimum_payout_threshold",
    prop: "minimumPayoutThreshold",
    label: "Minimum payout threshold",
    help: "Payouts below this amount require an explicit override.",
  },
  {
    key: "commission_hold_days",
    prop: "commissionHoldDays",
    label: "Commission hold period (days)",
    help: "Waiting period before a paid, non-refunded order's commission is eligible for payout.",
  },
] as const;

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function AdminPartnersClient({
  initialRows,
  initialTiers,
  initialSettings,
  initialFraudRows,
  initialPayoutHistory,
  initialMarketingResources,
  programDefaultDiscountPercent,
  programDefaultCommissionPercent,
}: {
  initialRows: AdminPartnerRow[];
  initialTiers: CommissionTierRule[];
  initialSettings: AmbassadorProgramSettings;
  initialFraudRows: FraudReviewRow[];
  initialPayoutHistory: PayoutHistoryRow[];
  initialMarketingResources: AmbassadorMarketingResource[];
  // Shown for every ambassador who has no override of their own, so the roster
  // states the rate customers actually get rather than a blank cell.
  programDefaultDiscountPercent: number;
  // Seeds the invite box. Previously a hardcoded "10" that matched the shipped
  // default by coincidence: an owner who moved the program rate in Control
  // Centre still got 10 pre-filled here, and every invite sent without touching
  // the box wrote the old rate.
  programDefaultCommissionPercent: number;
}) {
  const [rows, setRows] = useState(initialRows);
  const [tiers, setTiers] = useState(initialTiers);
  const [settings, setSettings] = useState(initialSettings);
  const [fraudRows, setFraudRows] = useState(initialFraudRows);
  const [payoutHistory, setPayoutHistory] = useState(initialPayoutHistory);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [payoutStatus, setPayoutStatus] = useState("all");
  const [payoutFrom, setPayoutFrom] = useState("");
  const [payoutTo, setPayoutTo] = useState("");
  const [payoutSearch, setPayoutSearch] = useState("");
  const [marketingResources, setMarketingResources] = useState<AmbassadorMarketingResource[]>(initialMarketingResources);
  const [newResourceTitle, setNewResourceTitle] = useState("");
  const [newResourceUrl, setNewResourceUrl] = useState("");
  const [newResourceDescription, setNewResourceDescription] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCommission, setInviteCommission] = useState(String(programDefaultCommissionPercent));
  const [newTierName, setNewTierName] = useState("");
  const [newTierMinSales, setNewTierMinSales] = useState("0");
  const [newTierPercent, setNewTierPercent] = useState("10");
  const [tab, setTab] = useState<TabKey>("overview");
  // Drafts are held separately from the resolved settings so the Save button
  // always sends what is on screen. The previous onBlur guard compared the typed
  // value against the DISPLAYED one and skipped the request when they matched --
  // which made a fallback value impossible to persist, because the fallback is
  // exactly what the box already showed.
  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});
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

  // Approved ambassadors who have actually produced at least one paid order -
  // "lowest" here means the ones who most need attention/coaching.
  const lowestPerformers = useMemo(
    () => [...rows]
      .filter((row) => row.status === "approved" && row.totalOrders > 0)
      .sort((a, b) => (a.totalRevenue + a.paidCommissions) - (b.totalRevenue + b.paidCommissions))
      .slice(0, 5),
    [rows],
  );

  // Program-wide rollups derived from the already-loaded rows (no extra query),
  // so every number updates automatically as orders complete.
  const totalAmbassadors = rows.length;
  const approvedCount = useMemo(() => rows.filter((row) => row.status === "approved").length, [rows]);
  const pendingCount = useMemo(() => rows.filter((row) => row.status === "pending").length, [rows]);
  const disabledCount = useMemo(() => rows.filter((row) => row.status === "disabled").length, [rows]);
  // "Active" = approved and actually generating orders, vs merely approved.
  const activeCount = useMemo(() => rows.filter((row) => row.status === "approved" && row.totalOrders > 0).length, [rows]);
  const totalOrders = useMemo(() => rows.reduce((sum, row) => sum + row.totalOrders, 0), [rows]);
  const totalClicks = useMemo(() => rows.reduce((sum, row) => sum + row.clicks, 0), [rows]);
  const balanceOwed = pendingCommissions + approvedForPayoutCommissions;
  const programAov = totalOrders > 0 ? liveSales / totalOrders : 0;
  const programConversionRate = totalClicks > 0 ? (totalOrders / totalClicks) * 100 : 0;

  const filteredPayouts = useMemo(() => {
    const fromTime = payoutFrom ? new Date(payoutFrom).getTime() : null;
    const toTime = payoutTo ? new Date(payoutTo).getTime() + 24 * 60 * 60 * 1000 - 1 : null;
    const q = payoutSearch.trim().toLowerCase();
    return payoutHistory.filter((row) => {
      if (q && !row.ambassadorName.toLowerCase().includes(q)) return false;
      const time = new Date(row.createdAt).getTime();
      if (fromTime !== null && !Number.isNaN(fromTime) && time < fromTime) return false;
      if (toTime !== null && !Number.isNaN(toTime) && time > toTime) return false;
      return true;
    });
  }, [payoutHistory, payoutFrom, payoutTo, payoutSearch]);
  const filteredPayoutTotal = useMemo(() => filteredPayouts.reduce((sum, row) => sum + row.amount, 0), [filteredPayouts]);

  const filteredRows = useMemo(() => rows.filter((row) => {
    const statusMatch = status === "all" || row.status === status;
    // Filter by which commission bucket the ambassador currently has money in,
    // so "unpaid" (approved_for_payout / pending) instantly narrows the table.
    const payoutMatch =
      payoutStatus === "all"
      || (payoutStatus === "pending" && row.pendingCommissions > 0)
      || (payoutStatus === "approved_for_payout" && row.approvedForPayoutCommissions > 0)
      || (payoutStatus === "paid" && row.paidCommissions > 0)
      || (payoutStatus === "reversed" && row.reversedCommissions > 0);
    const q = search.trim().toLowerCase();
    const searchMatch = !q
      || row.name.toLowerCase().includes(q)
      || (row.email ?? "").toLowerCase().includes(q)
      || row.referralCode.toLowerCase().includes(q);
    return statusMatch && payoutMatch && searchMatch;
  }), [rows, search, status, payoutStatus]);

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
      setInviteCommission(String(programDefaultCommissionPercent));
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

    // Marking paid RECORDS a transfer you've already made — it does not send
    // money. Require the admin to affirm the funds were actually sent (the
    // server enforces this too) before we flip commissions to paid and email
    // the ambassador "we sent you $X".
    const affirmed = window.confirm(
      `Have you ALREADY sent ${currency(row.approvedForPayoutCommissions)} to ${row.name} (${row.referralCode})?\n\n` +
      `Click OK ONLY if the money has actually been transferred. This records the payment and notifies the ambassador — it does not move any funds.`,
    );
    if (!affirmed) return;

    const transactionReference = window.prompt(
      "Optional: transfer/transaction reference (e.g. PayPal transaction ID). Leave blank to skip.",
      "",
    );
    // Cancel on the reference prompt aborts the whole action (safer default).
    if (transactionReference === null) return;

    await applyPartnerAction(row.id, {
      action: "mark_paid",
      amount: row.approvedForPayoutCommissions,
      note: "Bulk payout",
      overrideMinimumThreshold,
      confirmedTransferred: true,
      transactionReference: transactionReference.trim() || null,
    });
  };

  const handleRemove = async (row: AdminPartnerRow) => {
    const confirmed = window.confirm(
      `Remove ambassador "${row.name}" (${row.referralCode})? They'll disappear from this list. This can't be undone. Ambassadors with recorded orders can't be removed — Disable them instead.`,
    );
    if (!confirmed) return;

    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/partners/${row.id}`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to remove ambassador");
      }
      await refreshRows();
      await refreshFraudAndPayouts();
      setMessage(`Ambassador "${row.name}" removed.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to remove ambassador");
    } finally {
      setLoading(false);
    }
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

  const saveMarketingResources = async (resources: AmbassadorMarketingResource[]) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/ambassadors/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketingResources: resources }),
      });
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json.error ?? "Unable to save marketing resources");
      }
      setMarketingResources(json.marketingResources ?? []);
      setMessage("Marketing resources saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save marketing resources");
    } finally {
      setLoading(false);
    }
  };

  const addMarketingResource = () => {
    const title = newResourceTitle.trim();
    const url = newResourceUrl.trim();
    if (!title || !url) {
      setMessage("A marketing resource needs a title and a link.");
      return;
    }
    if (!/^https?:\/\//i.test(url) && !url.startsWith("/")) {
      setMessage("Resource links must start with http:// or https://");
      return;
    }
    const next = [...marketingResources, { title, url, description: newResourceDescription.trim() }];
    setNewResourceTitle("");
    setNewResourceUrl("");
    setNewResourceDescription("");
    void saveMarketingResources(next);
  };

  const removeMarketingResource = (index: number) => {
    void saveMarketingResources(marketingResources.filter((_, i) => i !== index));
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
      {/* One page, six views. The sections themselves are unchanged -- what
          changed is that an owner opening this page is no longer handed all of
          them at once. Filters and roster state persist across tabs, so
          switching never silently drops a search. */}
      <nav className="flex flex-wrap gap-2 border-b border-zinc-800/70 pb-3">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setTab(entry.key);
              // Applications IS the roster narrowed to applicants. Moving the
              // real filter (rather than hiding rows behind the tab) keeps the
              // dropdown honest about what is on screen.
              if (entry.key === "applications") setStatus("pending");
              if (entry.key === "ambassadors") setStatus("all");
            }}
            className={`vl-focus-ring rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-[0.16em] ${
              tab === entry.key ? "bg-zinc-100 text-zinc-950" : "border border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {entry.label}
            {entry.key === "applications" && pendingCount > 0 ? (
              <span className="ml-2 rounded-full bg-amber-400/20 px-2 py-0.5 text-amber-200">{pendingCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (<>
      {/* The six numbers an owner actually opens this page for. Everything
          secondary moved to the row beneath, so the headline stays readable. */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Ambassador Program</h2>
        <div className="mt-3 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Active Ambassadors</p>
            <p className="mt-2 text-2xl font-semibold text-emerald-300">{activeCount}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{approvedCount} approved</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Pending Applications</p>
            <p className="mt-2 text-2xl font-semibold text-amber-300">{pendingCount}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Ambassador Sales</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(liveSales)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Ambassador Orders</p>
            <p className="mt-2 text-2xl font-semibold text-white">{totalOrders}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Commission Owed</p>
            <p className="mt-2 text-2xl font-semibold text-cyan-300">{currency(balanceOwed)}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{currency(approvedForPayoutCommissions)} ready · {currency(pendingCommissions)} holding</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Commission Paid</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(paidCommissions)}</p>
          </div>
        </div>
      </section>

      <section>
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Avg Order Value</p>
            <p className="mt-2 text-xl font-semibold text-white">{currency(programAov)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Conversion</p>
            <p className="mt-2 text-xl font-semibold text-white">{programConversionRate.toFixed(1)}%</p>
            <p className="mt-1 text-[11px] text-zinc-500">{totalOrders} orders / {totalClicks} clicks</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Reversed</p>
            <p className="mt-2 text-xl font-semibold text-zinc-400">{currency(reversedCommissions)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Disabled</p>
            <p className="mt-2 text-xl font-semibold text-zinc-400">{disabledCount}</p>
            <p className="mt-1 text-[11px] text-zinc-500">{totalAmbassadors} total</p>
          </div>
        </div>
      </section>
      </>) : null}

      {tab === "analytics" ? (<>
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

      {lowestPerformers.length > 0 ? (
        <section className="vl-panel rounded-2xl p-4 sm:p-5">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Needs Attention</h2>
          <p className="mt-1 text-xs text-zinc-500">Approved ambassadors with the lowest sales so far - candidates for a check-in or coaching.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {lowestPerformers.map((row) => (
              <div key={row.id} className="rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
                <p className="truncate text-sm font-semibold text-white">{row.name}</p>
                <p className="mt-1 text-xs text-zinc-400">{currency(row.totalRevenue)} revenue</p>
                <p className="text-xs text-zinc-500">{row.totalOrders} orders · {row.clicks} clicks</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

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
      </>) : null}

      {tab === "program" ? (<>
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
                <th className="px-2 py-2">Min monthly orders</th>
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
          <input type="number" min={0} value={newTierMinSales} onChange={(event) => setNewTierMinSales(event.target.value)} placeholder="Min monthly orders" className="vl-input px-3 py-2 text-sm" />
          <input type="number" min={0} max={100} step={0.5} value={newTierPercent} onChange={(event) => setNewTierPercent(event.target.value)} placeholder="Commission %" className="vl-input px-3 py-2 text-sm" />
          <button type="submit" disabled={loading} className="vl-focus-ring rounded-lg bg-gradient-to-r from-cyan-300 via-blue-200 to-indigo-200 px-4 py-2 text-sm font-semibold text-zinc-950">
            Add Tier
          </button>
        </form>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Ambassador Program Settings</h2>
        <p className="mt-1 text-xs text-zinc-500">
          A field marked <span className="text-amber-300">Default</span> is showing a built-in value that is NOT stored. Press Save to
          make it your recorded policy — otherwise a future change to the built-in default would move it silently.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {PROGRAM_SETTING_FIELDS.map((field) => {
            // Unknown provenance reads as Default, never as Saved. Claiming a value is
            // stored when it is not is the exact lie this chip exists to prevent.
            const isStored = settings.stored?.[field.prop] ?? false;
            const draft = settingDrafts[field.key] ?? String(settings[field.prop]);
            return (
              <div key={field.key} className="text-sm text-zinc-300">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-[0.18em] text-zinc-500">{field.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${
                    isStored ? "bg-emerald-400/15 text-emerald-200" : "bg-amber-400/15 text-amber-200"
                  }`}>
                    {isStored ? "Saved" : "Default"}
                  </span>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0}
                    value={draft}
                    onChange={(event) => setSettingDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    className="vl-input w-full px-3 py-2 text-sm"
                    aria-label={field.label}
                  />
                  <button
                    type="button"
                    disabled={loading || draft.trim() === ""}
                    onClick={() => updateSetting(field.key, Number(draft))}
                    className="vl-focus-ring flex-shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-100 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
                <span className="mt-1 block text-xs text-zinc-500">{field.help}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Marketing Resources</h2>
        <p className="mt-1 text-xs text-zinc-500">Links and assets shown to approved ambassadors on their dashboard (banners, brand kit, swipe copy, etc.). Leave empty to hide the section.</p>

        {marketingResources.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {marketingResources.map((resource, index) => (
              <li key={`${resource.title}-${resource.url}`} className="flex items-start justify-between gap-3 rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{resource.title}</p>
                  {resource.description ? <p className="text-xs text-zinc-400">{resource.description}</p> : null}
                  <p className="truncate text-xs text-cyan-300/80">{resource.url}</p>
                </div>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => removeMarketingResource(index)}
                  className="rounded border border-rose-400/35 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 disabled:opacity-50"
                >Remove</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">No marketing resources yet.</p>
        )}

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input value={newResourceTitle} onChange={(e) => setNewResourceTitle(e.target.value)} placeholder="Title (e.g. Brand Kit)" className="vl-input px-3 py-2 text-sm" />
          <input value={newResourceUrl} onChange={(e) => setNewResourceUrl(e.target.value)} placeholder="https://link-to-asset" className="vl-input px-3 py-2 text-sm" />
          <input value={newResourceDescription} onChange={(e) => setNewResourceDescription(e.target.value)} placeholder="Short description (optional)" className="vl-input px-3 py-2 text-sm" />
          <button type="button" disabled={loading} onClick={addMarketingResource} className="vl-btn-secondary px-4 py-2 text-sm disabled:opacity-50">Add Resource</button>
        </div>
      </section>
      </>) : null}

      {tab === "ambassadors" || tab === "applications" ? (<>
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
            Export Balances CSV
          </button>
        </div>

        {message ? <p className="mt-3 text-sm text-cyan-200">{message}</p> : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="px-2 py-2">Partner</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Rates</th>
                <th className="px-2 py-2">Revenue</th>
                <th className="px-2 py-2">Orders</th>
                <th className="px-2 py-2">Commission</th>
                <th className="px-2 py-2">Owed</th>
                <th className="px-2 py-2">Clicks</th>
                <th className="px-2 py-2">Conv %</th>
                <th className="px-2 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-2 py-6 text-center text-sm text-zinc-500">
                    No ambassadors match these filters.
                  </td>
                </tr>
              ) : null}
              {filteredRows.map((row) => (
                <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                  <td className="px-2 py-2">
                    <a href={`/admin/partners/${row.id}`} className="font-semibold text-white hover:text-cyan-200">{row.name}</a>
                    <p className="text-xs text-zinc-500">{row.email ?? "-"}</p>
                    {row.phone ? <p className="text-xs text-zinc-500">📞 {row.phone}</p> : null}
                    {row.social ? <p className="text-xs text-zinc-500 break-all">🔗 {row.social}</p> : null}
                    {row.followerCount != null ? <p className="text-xs text-zinc-500">👥 {row.followerCount.toLocaleString()} followers</p> : null}
                    <p className="mt-1 font-mono text-xs text-cyan-300/80">/r/{row.referralCode}</p>
                  </td>
                  <td className="px-2 py-2">{row.status}</td>
                  <td className="px-2 py-2 whitespace-nowrap">
                    <p className="text-xs text-zinc-400">
                      Customer{" "}
                      <span className="font-semibold text-cyan-200">
                        {row.customerDiscountPercent ?? programDefaultDiscountPercent}%
                      </span>
                      {row.customerDiscountPercent == null ? <span className="text-zinc-600"> (default)</span> : null}
                    </p>
                    <p className="text-xs text-zinc-400">
                      Earns{" "}
                      <span className="font-semibold text-emerald-200">{row.commissionPercent}%</span>
                    </p>
                  </td>
                  <td className="px-2 py-2">{currency(row.totalRevenue)}</td>
                  <td className="px-2 py-2">{row.totalOrders}</td>
                  <td className="px-2 py-2">
                    <p>{currency(row.paidCommissions)} paid</p>
                    <p className="text-xs text-zinc-500">{currency(row.pendingCommissions)} pending</p>
                    <p className="text-xs text-zinc-500">{currency(row.approvedForPayoutCommissions)} approved</p>
                    <p className="text-xs text-zinc-500">{currency(row.reversedCommissions)} reversed</p>
                    <p className="mt-1 text-xs">
                      {row.commissionPercentLocked ? (
                        <span className="text-amber-300">{row.commissionPercent}% (manual)</span>
                      ) : (
                        <span className="text-emerald-300">Auto tiers active</span>
                      )}
                    </p>
                  </td>
                  <td className="px-2 py-2 font-semibold text-cyan-200">{currency(row.pendingCommissions + row.approvedForPayoutCommissions)}</td>
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
                      >Set Earns %</button>
                      {/*
                        THE CUSTOMER DISCOUNT — a SEPARATE control, deliberately.

                        These are two different rates that must never move each
                        other: what the shopper comes off with, and what the
                        ambassador earns. They were previously editable only
                        through the program default, so setting one person's
                        discount meant changing it for everyone.

                        Blank clears the override and returns this ambassador to
                        the program default, which is why the prompt says so and
                        why an empty string is sent as null rather than 0 — a 0%
                        discount and "use the default" are different intentions
                        and the API distinguishes them.
                      */}
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          const current = row.customerDiscountPercent == null ? "" : String(row.customerDiscountPercent);
                          const input = window.prompt(
                            `Customer discount for ${row.name} — the % their followers come off with.\n\nLeave blank to use the program default (${programDefaultDiscountPercent}%).`,
                            current,
                          );
                          if (input === null) return;
                          const trimmed = input.trim();
                          if (trimmed === "") {
                            applyPartnerAction(row.id, {
                              action: "set_status",
                              status: row.status,
                              customerDiscountPercent: null,
                            });
                            return;
                          }
                          const value = Number(trimmed);
                          // Mirrors the API's own guard: 100% off is free product,
                          // not a discount, so the range stops short of it.
                          if (!Number.isFinite(value) || value < 0 || value >= 100) {
                            setMessage("Customer discount must be 0 or more and less than 100.");
                            return;
                          }
                          applyPartnerAction(row.id, {
                            action: "set_status",
                            status: row.status,
                            customerDiscountPercent: value,
                          });
                        }}
                        className="rounded border border-cyan-400/35 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200"
                      >Set Discount</button>
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
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => handleRemove(row)}
                        className="rounded border border-rose-500/40 bg-rose-600/10 px-2 py-1 text-xs text-rose-200 disabled:opacity-50"
                      >Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </>) : null}

      {tab === "payouts" ? (<>
      <section className="vl-panel rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-300">Payout History</h2>
          <p className="text-xs text-zinc-400">Showing {filteredPayouts.length} of {payoutHistory.length} · {currency(filteredPayoutTotal)} total</p>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-zinc-500">
            <span className="mb-1 block">From</span>
            <input type="date" value={payoutFrom} onChange={(e) => setPayoutFrom(e.target.value)} className="vl-input rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-zinc-500">
            <span className="mb-1 block">To</span>
            <input type="date" value={payoutTo} onChange={(e) => setPayoutTo(e.target.value)} className="vl-input rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs text-zinc-500">
            <span className="mb-1 block">Ambassador</span>
            <input type="text" value={payoutSearch} onChange={(e) => setPayoutSearch(e.target.value)} placeholder="Filter by name" className="vl-input rounded-lg px-2 py-1.5 text-sm" />
          </label>
          {(payoutFrom || payoutTo || payoutSearch) ? (
            <button
              type="button"
              onClick={() => { setPayoutFrom(""); setPayoutTo(""); setPayoutSearch(""); }}
              className="vl-btn-secondary px-3 py-1.5 text-xs"
            >Clear</button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const params = new URLSearchParams();
              if (payoutFrom) params.set("from", payoutFrom);
              if (payoutTo) params.set("to", payoutTo);
              if (payoutSearch.trim()) {
                const match = payoutHistory.find((row) => row.ambassadorName.toLowerCase().includes(payoutSearch.trim().toLowerCase()));
                if (match) params.set("ambassadorId", match.ambassadorId);
              }
              const query = params.toString();
              window.location.href = `/api/admin/partners/export-payout-history${query ? `?${query}` : ""}`;
            }}
            className="vl-btn-secondary px-3 py-1.5 text-xs"
          >Export History CSV</button>
        </div>

        {payoutHistory.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No payouts recorded yet.</p>
        ) : filteredPayouts.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No payouts match these filters.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-zinc-500">
                  <th className="px-2 py-2">Date Paid</th>
                  <th className="px-2 py-2">Ambassador</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-2 py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayouts.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-800/70 text-zinc-200">
                    <td className="px-2 py-2 text-xs text-zinc-400">{formatDate(row.createdAt)}</td>
                    <td className="px-2 py-2">{row.ambassadorName}</td>
                    <td className="px-2 py-2 font-semibold text-white">{currency(row.amount)}</td>
                    <td className="px-2 py-2 text-xs text-zinc-400">{row.note ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </>) : null}
    </div>
  );
}
