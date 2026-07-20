"use client";

import { useState } from "react";
import Link from "next/link";
import type { MembershipTier } from "@/lib/membership";
import type { MembershipAnalytics, PromotionalPointEvent, CustomerBalanceRow, BulkSavingsStats } from "@/lib/admin-membership";
import type { BulkSavingsConfig } from "@/lib/bulk-savings";

type BonusSettings = {
  signupBonusEnabled: boolean;
  referralBonusEnabled: boolean;
  birthdayBonusEnabled: boolean;
  signupBonusPoints: number;
  referralSignupBonusPoints: number;
  birthdayBonusPoints: number;
};

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function AdminMembershipClient({
  initialTiers,
  initialEvents,
  initialAnalytics,
  initialBonusSettings,
  initialBulkSavingsConfig,
  initialBulkSavingsStats,
}: {
  initialTiers: MembershipTier[];
  initialEvents: PromotionalPointEvent[];
  initialAnalytics: MembershipAnalytics;
  initialBonusSettings: BonusSettings;
  initialBulkSavingsConfig: BulkSavingsConfig;
  initialBulkSavingsStats: BulkSavingsStats;
}) {
  const [tiers, setTiers] = useState(initialTiers);
  const [events, setEvents] = useState(initialEvents);
  const [analytics] = useState(initialAnalytics);
  const [bonusSettings, setBonusSettings] = useState(initialBonusSettings);
  const [bulkSavingsConfig, setBulkSavingsConfig] = useState(initialBulkSavingsConfig);
  const [bulkSavingsStats] = useState(initialBulkSavingsStats);
  const [savingBulkSavings, setSavingBulkSavings] = useState(false);
  const [customers, setCustomers] = useState<CustomerBalanceRow[] | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newEventName, setNewEventName] = useState("");
  const [newEventMultiplier, setNewEventMultiplier] = useState("2");
  const [newEventStart, setNewEventStart] = useState("");
  const [newEventEnd, setNewEventEnd] = useState("");
  const [creatingEvent, setCreatingEvent] = useState(false);

  const [adjustUserId, setAdjustUserId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const saveTier = async (tier: MembershipTier, changes: Partial<MembershipTier>) => {
    setBusyId(tier.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/membership/tiers/${tier.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to update tier.");
        return;
      }
      setTiers((prev) => prev.map((t) => (t.id === tier.id ? { ...t, ...changes } : t)));
    } catch {
      setMessage("Unable to update tier right now.");
    } finally {
      setBusyId(null);
    }
  };

  const createEvent = async () => {
    if (!newEventName.trim() || !newEventStart || !newEventEnd) {
      setMessage("Enter a name, start, and end date for the promotional event.");
      return;
    }

    setCreatingEvent(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/membership/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newEventName,
          multiplier: Number(newEventMultiplier),
          startsAt: new Date(newEventStart).toISOString(),
          endsAt: new Date(newEventEnd).toISOString(),
        }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to create event.");
        return;
      }
      setMessage(`Event "${newEventName}" created.`);
      setNewEventName("");
      setNewEventMultiplier("2");
      setNewEventStart("");
      setNewEventEnd("");
      window.location.reload();
    } catch {
      setMessage("Unable to create event right now.");
    } finally {
      setCreatingEvent(false);
    }
  };

  const toggleEvent = async (event: PromotionalPointEvent) => {
    setBusyId(event.id);
    try {
      const response = await fetch(`/api/admin/membership/events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !event.isActive }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to update event.");
        return;
      }
      setEvents((prev) => prev.map((e) => (e.id === event.id ? { ...e, isActive: !e.isActive } : e)));
    } catch {
      setMessage("Unable to update event right now.");
    } finally {
      setBusyId(null);
    }
  };

  const saveBonusSettings = async () => {
    setMessage(null);
    try {
      const response = await fetch("/api/admin/membership/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bonusSettings),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setMessage(result.success ? "Bonus settings saved." : (result.error ?? "Unable to save settings."));
    } catch {
      setMessage("Unable to save settings right now.");
    }
  };

  const saveBulkSavingsConfig = async () => {
    setSavingBulkSavings(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/membership/bulk-savings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bulkSavingsConfig),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setMessage(result.success ? "Bulk savings settings saved." : (result.error ?? "Unable to save settings."));
    } catch {
      setMessage("Unable to save bulk savings settings right now.");
    } finally {
      setSavingBulkSavings(false);
    }
  };

  const loadCustomers = async () => {
    setLoadingCustomers(true);
    try {
      const response = await fetch(`/api/admin/membership/customers?search=${encodeURIComponent(customerSearch)}`);
      const result = await response.json() as { success: boolean; rows?: CustomerBalanceRow[]; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to load customer balances.");
        return;
      }
      setCustomers(result.rows ?? []);
    } catch {
      setMessage("Unable to load customer balances right now.");
    } finally {
      setLoadingCustomers(false);
    }
  };

  const submitAdjustment = async (userId: string) => {
    const amount = Number(adjustAmount);
    if (!amount || !adjustNote.trim()) {
      setMessage("Enter a non-zero amount and a note for the adjustment.");
      return;
    }

    setBusyId(userId);
    try {
      const response = await fetch(`/api/admin/membership/customers/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "adjust_points", amount, note: adjustNote }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to adjust points.");
        return;
      }
      setMessage("Points adjusted.");
      setAdjustUserId(null);
      setAdjustAmount("");
      setAdjustNote("");
      await loadCustomers();
    } catch {
      setMessage("Unable to adjust points right now.");
    } finally {
      setBusyId(null);
    }
  };

  const setStatus = async (userId: string, status: "active" | "paused" | "cancelled") => {
    setBusyId(userId);
    try {
      const response = await fetch(`/api/admin/membership/customers/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_status", status }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to update membership status.");
        return;
      }
      await loadCustomers();
    } catch {
      setMessage("Unable to update membership status right now.");
    } finally {
      setBusyId(null);
    }
  };

  const assignTier = async (userId: string, tierId: string) => {
    if (!tierId) return;
    setBusyId(userId);
    try {
      const response = await fetch(`/api/admin/membership/customers/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_tier", tierId, billingCycle: "monthly" }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setMessage(result.error ?? "Unable to assign tier.");
        return;
      }
      setMessage("Tier assigned. Billing is not connected — this is a manual activation.");
      await loadCustomers();
    } catch {
      setMessage("Unable to assign tier right now.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {message ? <p className="vl-panel rounded-xl p-3 text-sm text-zinc-200">{message}</p> : null}

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Analytics</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Monthly Recurring Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(analytics.monthlyRecurringRevenueCents)}</p>
            <p className="mt-1 text-xs text-amber-300">Projection from tier prices — not real captured revenue.</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Real Revenue (30d)</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(analytics.realRecurringRevenueCents30d)}</p>
            <p className="mt-1 text-xs text-zinc-500">From actual successful charges. $0 until a billing processor is connected.</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Points Outstanding</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.totalPointsOutstanding.toLocaleString()}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Active Promo Events</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.activePromotionalEventCount}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Active Intro Members</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.activeIntroMembers}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Trial → Paid Conversion (30d)</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.trialToPaidConversionRate}%</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Renewals / Cancellations (30d)</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.renewalsCount30d} / {analytics.cancellationsCount30d}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Failed Payments / Recovery Attempts (30d)</p>
            <p className="mt-2 text-2xl font-semibold text-white">{analytics.failedPaymentsCount30d} / {analytics.recoveryAttemptsCount30d}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4 sm:col-span-2 lg:col-span-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Active Members by Tier</p>
            <div className="mt-2 space-y-1 text-sm text-zinc-300">
              {analytics.activeMembersByTier.length === 0 ? <p className="text-zinc-500">None yet</p> : null}
              {analytics.activeMembersByTier.map((row) => (
                <p key={row.tierName}>{row.tierName}: {row.count}</p>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Membership Tiers</h2>
        <div className="mt-4 space-y-4">
          {tiers.map((tier) => (
            <div key={tier.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-white">{tier.name} <span className="text-xs text-zinc-500">({tier.slug})</span></p>
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <input type="checkbox" checked={tier.isActive} onChange={(e) => saveTier(tier, { isActive: e.target.checked })} disabled={busyId === tier.id} />
                  Active
                </label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <label className="text-xs text-zinc-400">
                  Monthly price ($)
                  <input
                    type="number"
                    defaultValue={(tier.monthlyPriceCents / 100).toFixed(2)}
                    onBlur={(e) => saveTier(tier, { monthlyPriceCents: Math.round(Number(e.target.value) * 100) })}
                    className="vl-input mt-1 w-full px-2 py-1.5"
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  Annual price ($)
                  <input
                    type="number"
                    defaultValue={(tier.annualPriceCents / 100).toFixed(2)}
                    onBlur={(e) => saveTier(tier, { annualPriceCents: Math.round(Number(e.target.value) * 100) })}
                    className="vl-input mt-1 w-full px-2 py-1.5"
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  Points per $1
                  <input
                    type="number"
                    step="0.5"
                    defaultValue={tier.pointsPerDollar}
                    onBlur={(e) => saveTier(tier, { pointsPerDollar: Number(e.target.value) })}
                    className="vl-input mt-1 w-full px-2 py-1.5"
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  Referral bonus (pts)
                  <input
                    type="number"
                    defaultValue={tier.referralBonusPoints}
                    onBlur={(e) => saveTier(tier, { referralBonusPoints: Number(e.target.value) })}
                    className="vl-input mt-1 w-full px-2 py-1.5"
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-zinc-300">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={tier.freeShipping} onChange={(e) => saveTier(tier, { freeShipping: e.target.checked })} />
                  Free shipping
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={tier.priorityShipping} onChange={(e) => saveTier(tier, { priorityShipping: e.target.checked })} />
                  Priority shipping
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={tier.earlyAccess} onChange={(e) => saveTier(tier, { earlyAccess: e.target.checked })} />
                  Early access
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={tier.exclusivePricing} onChange={(e) => saveTier(tier, { exclusivePricing: e.target.checked })} />
                  Exclusive pricing
                </label>
              </div>

              {tier.slug !== "free" ? (
                <div className="mt-4 border-t border-white/10 pt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Intro offer</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-4">
                    <label className="flex items-center gap-1.5 text-xs text-zinc-300">
                      <input type="checkbox" checked={tier.introOfferEnabled} onChange={(e) => saveTier(tier, { introOfferEnabled: e.target.checked })} />
                      Enabled
                    </label>
                    <label className="text-xs text-zinc-400">
                      Intro price ($)
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={(tier.introPriceCents / 100).toFixed(2)}
                        onBlur={(e) => saveTier(tier, { introPriceCents: Math.round(Number(e.target.value) * 100) })}
                        className="vl-input mt-1 w-full px-2 py-1.5"
                      />
                    </label>
                    <label className="text-xs text-zinc-400">
                      Intro duration (days)
                      <input
                        type="number"
                        defaultValue={tier.introDurationDays}
                        onBlur={(e) => saveTier(tier, { introDurationDays: Number(e.target.value) })}
                        className="vl-input mt-1 w-full px-2 py-1.5"
                      />
                    </label>
                    <label className="text-xs text-zinc-400">
                      Member discount (%)
                      <input
                        type="number"
                        step="0.5"
                        defaultValue={tier.memberDiscountPercent}
                        onBlur={(e) => saveTier(tier, { memberDiscountPercent: Number(e.target.value) })}
                        className="vl-input mt-1 w-full px-2 py-1.5"
                      />
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Promotional Point Events (Double Points, Seasonal)</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <input value={newEventName} onChange={(e) => setNewEventName(e.target.value)} placeholder="Event name" className="vl-input px-3 py-2 text-sm" />
          <input type="number" step="0.5" value={newEventMultiplier} onChange={(e) => setNewEventMultiplier(e.target.value)} placeholder="Multiplier" className="vl-input px-3 py-2 text-sm" />
          <input type="datetime-local" value={newEventStart} onChange={(e) => setNewEventStart(e.target.value)} className="vl-input px-3 py-2 text-sm" />
          <input type="datetime-local" value={newEventEnd} onChange={(e) => setNewEventEnd(e.target.value)} className="vl-input px-3 py-2 text-sm" />
        </div>
        <button type="button" onClick={createEvent} disabled={creatingEvent} className="vl-btn-primary vl-focus-ring mt-3 px-5 py-2.5 text-sm disabled:opacity-60">
          {creatingEvent ? "Creating…" : "Create event"}
        </button>

        <div className="mt-4 space-y-2">
          {events.map((event) => (
            <div key={event.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm">
              <span className="text-zinc-200">
                {event.name} — {event.multiplier}x ({new Date(event.startsAt).toLocaleDateString()} → {new Date(event.endsAt).toLocaleDateString()})
              </span>
              <button
                type="button"
                onClick={() => toggleEvent(event)}
                disabled={busyId === event.id}
                className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
              >
                {event.isActive ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
          {events.length === 0 ? <p className="text-sm text-zinc-500">No promotional events yet.</p> : null}
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Bonus Settings</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={bonusSettings.signupBonusEnabled} onChange={(e) => setBonusSettings((prev) => ({ ...prev, signupBonusEnabled: e.target.checked }))} />
              Signup bonus
            </label>
            <input
              type="number"
              value={bonusSettings.signupBonusPoints}
              onChange={(e) => setBonusSettings((prev) => ({ ...prev, signupBonusPoints: Number(e.target.value) }))}
              className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
            />
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={bonusSettings.referralBonusEnabled} onChange={(e) => setBonusSettings((prev) => ({ ...prev, referralBonusEnabled: e.target.checked }))} />
              Referral signup bonus
            </label>
            <input
              type="number"
              value={bonusSettings.referralSignupBonusPoints}
              onChange={(e) => setBonusSettings((prev) => ({ ...prev, referralSignupBonusPoints: Number(e.target.value) }))}
              className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
            />
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input type="checkbox" checked={bonusSettings.birthdayBonusEnabled} onChange={(e) => setBonusSettings((prev) => ({ ...prev, birthdayBonusEnabled: e.target.checked }))} />
              Birthday bonus
            </label>
            <input
              type="number"
              value={bonusSettings.birthdayBonusPoints}
              onChange={(e) => setBonusSettings((prev) => ({ ...prev, birthdayBonusPoints: Number(e.target.value) }))}
              className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <button type="button" onClick={saveBonusSettings} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm">
          Save bonus settings
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">Exclusive Buy In Bulk Savings (Elite Tier)</h2>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={bulkSavingsConfig.enabled}
              onChange={(e) => setBulkSavingsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
            />
            Program enabled
          </label>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Tier 1</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">
                Threshold ($)
                <input
                  type="number"
                  value={bulkSavingsConfig.tier1Threshold}
                  onChange={(e) => setBulkSavingsConfig((prev) => ({ ...prev, tier1Threshold: Number(e.target.value) }))}
                  className="vl-input mt-1 w-full px-2 py-1.5"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Discount (%)
                <input
                  type="number"
                  step="0.5"
                  value={bulkSavingsConfig.tier1Percent}
                  onChange={(e) => setBulkSavingsConfig((prev) => ({ ...prev, tier1Percent: Number(e.target.value) }))}
                  className="vl-input mt-1 w-full px-2 py-1.5"
                />
              </label>
            </div>
            <p className="mt-3 text-xs text-zinc-500">{bulkSavingsStats.tier5PercentOrders} orders · {money(bulkSavingsStats.tier5PercentRevenueCents)} revenue</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Tier 2</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">
                Threshold ($)
                <input
                  type="number"
                  value={bulkSavingsConfig.tier2Threshold}
                  onChange={(e) => setBulkSavingsConfig((prev) => ({ ...prev, tier2Threshold: Number(e.target.value) }))}
                  className="vl-input mt-1 w-full px-2 py-1.5"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Discount (%)
                <input
                  type="number"
                  step="0.5"
                  value={bulkSavingsConfig.tier2Percent}
                  onChange={(e) => setBulkSavingsConfig((prev) => ({ ...prev, tier2Percent: Number(e.target.value) }))}
                  className="vl-input mt-1 w-full px-2 py-1.5"
                />
              </label>
            </div>
            <p className="mt-3 text-xs text-zinc-500">{bulkSavingsStats.tier12PercentOrders} orders · {money(bulkSavingsStats.tier12PercentRevenueCents)} revenue</p>
          </div>
        </div>

        <button type="button" onClick={saveBulkSavingsConfig} disabled={savingBulkSavings} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingBulkSavings ? "Saving…" : "Save bulk savings settings"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-white">Customer Balances</h2>
          <Link href="/api/admin/membership/export" className="vl-btn-secondary px-4 py-2 text-xs">Export CSV</Link>
        </div>
        <div className="mt-4 flex gap-2">
          <input value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Search email" className="vl-input flex-1 px-3 py-2 text-sm" />
          <button type="button" onClick={loadCustomers} disabled={loadingCustomers} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-60">
            {loadingCustomers ? "Loading…" : "Load"}
          </button>
        </div>

        {customers ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2 pr-4">Email</th>
                  <th className="pb-2 pr-4">Tier</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Points</th>
                  <th className="pb-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.userId} className="border-t border-white/10">
                    <td className="py-2 pr-4 text-zinc-200">{customer.email}</td>
                    <td className="py-2 pr-4 text-zinc-400">{customer.tierName}</td>
                    <td className="py-2 pr-4 text-zinc-400">{customer.status}</td>
                    <td className="py-2 pr-4 text-zinc-200">{customer.pointsBalance.toLocaleString()}</td>
                    <td className="py-2 pr-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setAdjustUserId(adjustUserId === customer.userId ? null : customer.userId)} className="vl-btn-secondary px-2.5 py-1 text-xs">
                          Adjust points
                        </button>
                        <button type="button" onClick={() => setStatus(customer.userId, "paused")} disabled={busyId === customer.userId} className="vl-btn-secondary px-2.5 py-1 text-xs disabled:opacity-60">
                          Pause
                        </button>
                        <button type="button" onClick={() => setStatus(customer.userId, "cancelled")} disabled={busyId === customer.userId} className="vl-btn-secondary px-2.5 py-1 text-xs disabled:opacity-60">
                          Cancel
                        </button>
                        <select
                          defaultValue=""
                          onChange={(e) => { assignTier(customer.userId, e.target.value); e.target.value = ""; }}
                          disabled={busyId === customer.userId}
                          className="vl-input px-2 py-1 text-xs disabled:opacity-60"
                        >
                          <option value="" disabled>Assign tier…</option>
                          {tiers.map((tier) => (
                            <option key={tier.id} value={tier.id}>{tier.name}</option>
                          ))}
                        </select>
                      </div>
                      {adjustUserId === customer.userId ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <input value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} placeholder="+/- points" className="vl-input w-28 px-2 py-1 text-xs" />
                          <input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Note" className="vl-input w-40 px-2 py-1 text-xs" />
                          <button type="button" onClick={() => submitAdjustment(customer.userId)} disabled={busyId === customer.userId} className="vl-btn-primary px-3 py-1 text-xs disabled:opacity-60">
                            Save
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {customers.length === 0 ? (
                  <tr><td colSpan={5} className="py-6 text-center text-sm text-zinc-500">No customers found.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
