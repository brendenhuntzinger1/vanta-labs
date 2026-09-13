"use client";

// The rewards points bonuses — signup, referral and birthday.
//
// This panel used to live inside admin-membership-client.tsx, which was the
// only place it had ever been rendered. When the paid membership feature was
// removed (2026-09-12) these controls had to move rather than go with it:
// they configure the POINTS programme, which stays. See
// docs/MEMBERSHIP-REMOVAL-AND-RESTORE.md.
//
// The markup and the three-card layout are carried over unchanged so the
// controls look and behave exactly as they did on /admin/membership.

import { useState } from "react";
import type { RewardsBonusSettings } from "@/lib/rewards";

export function AdminRewardsBonusPanel({
  initialSettings,
  canManage,
}: {
  initialSettings: RewardsBonusSettings;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<RewardsBonusSettings>(initialSettings);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/rewards/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json().catch(() => ({}));
      // Report the server's own refusal rather than a generic failure: the
      // route validates the point values and explains which one is out of
      // range, and that message is the useful half.
      setStatus(response.ok && payload?.success ? "Saved." : String(payload?.error ?? "Unable to save."));
    } catch {
      setStatus("Unable to reach the server.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vl-panel rounded-2xl p-5">
      <h2 className="text-lg font-semibold">Rewards bonuses</h2>
      <p className="mt-1 text-sm text-zinc-400">
        One-off points awarded to customers. Turning one off stops future awards; points already
        granted are never withdrawn.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={settings.signupBonusEnabled}
              disabled={!canManage}
              onChange={(e) => setSettings((prev) => ({ ...prev, signupBonusEnabled: e.target.checked }))}
            />
            Signup bonus
          </label>
          <input
            type="number"
            min={0}
            value={settings.signupBonusPoints}
            disabled={!canManage}
            onChange={(e) => setSettings((prev) => ({ ...prev, signupBonusPoints: Number(e.target.value) }))}
            className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
          />
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={settings.referralBonusEnabled}
              disabled={!canManage}
              onChange={(e) => setSettings((prev) => ({ ...prev, referralBonusEnabled: e.target.checked }))}
            />
            Referral signup bonus
          </label>
          <input
            type="number"
            min={0}
            value={settings.referralSignupBonusPoints}
            disabled={!canManage}
            onChange={(e) => setSettings((prev) => ({ ...prev, referralSignupBonusPoints: Number(e.target.value) }))}
            className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
          />
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <label className="flex items-center gap-2 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={settings.birthdayBonusEnabled}
              disabled={!canManage}
              onChange={(e) => setSettings((prev) => ({ ...prev, birthdayBonusEnabled: e.target.checked }))}
            />
            Birthday bonus
          </label>
          <input
            type="number"
            min={0}
            value={settings.birthdayBonusPoints}
            disabled={!canManage}
            onChange={(e) => setSettings((prev) => ({ ...prev, birthdayBonusPoints: Number(e.target.value) }))}
            className="vl-input mt-2 w-full px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {canManage ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="vl-btn-primary vl-focus-ring px-5 py-2.5 text-sm disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save bonus settings"}
          </button>
          {status ? <span className="text-sm text-zinc-400">{status}</span> : null}
        </div>
      ) : (
        <p className="mt-4 text-sm text-zinc-500">Your role can view these but not change them.</p>
      )}
    </div>
  );
}
