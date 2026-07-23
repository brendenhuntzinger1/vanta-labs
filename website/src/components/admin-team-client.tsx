"use client";

import { useState } from "react";
import type { AdminAccountRow } from "@/lib/admin-team";
import type { AdminRole } from "@/lib/admin-roles";

const ROLE_OPTIONS: AdminRole[] = ["staff", "manager", "super_admin"];

export function AdminTeamClient({ initialAccounts, currentUsername }: { initialAccounts: AdminAccountRow[]; currentUsername: string }) {
  const [accounts, setAccounts] = useState<AdminAccountRow[]>(initialAccounts);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminRole>("staff");
  const [creating, setCreating] = useState(false);
  const [busyUsername, setBusyUsername] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const response = await fetch("/api/admin/team");
    const result = await response.json() as { success: boolean; accounts?: AdminAccountRow[] };
    if (result.success && result.accounts) {
      setAccounts(result.accounts);
    }
  };

  const handleCreate = async () => {
    setError(null);
    setMessage(null);

    if (!username.trim() || password.length < 12) {
      setError("Enter a username and a password of at least 12 characters.");
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/admin/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to create account.");
        return;
      }
      setMessage(`Account "${username.trim().toLowerCase()}" created.`);
      setUsername("");
      setPassword("");
      setRole("staff");
      await refresh();
    } catch {
      setError("Unable to create account right now.");
    } finally {
      setCreating(false);
    }
  };

  const changeRole = async (account: AdminAccountRow, nextRole: AdminRole) => {
    setBusyUsername(account.username);
    setError(null);
    try {
      const response = await fetch(`/api/admin/team/${encodeURIComponent(account.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to update role.");
        return;
      }
      await refresh();
    } catch {
      setError("Unable to update role right now.");
    } finally {
      setBusyUsername(null);
    }
  };

  const setPasscode = async (account: AdminAccountRow) => {
    setError(null);
    setMessage(null);
    const entered = window.prompt(
      `Set a 6-digit login passcode for "${account.username}". This is the second step required after their username and password.`,
    );
    if (entered === null) {
      return;
    }
    const passcode = entered.replace(/\D/g, "");
    if (passcode.length !== 6) {
      setError("Passcode must be exactly 6 digits.");
      return;
    }

    setBusyUsername(account.username);
    try {
      const response = await fetch(`/api/admin/team/${encodeURIComponent(account.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to set passcode.");
        return;
      }
      setMessage(`Passcode set for "${account.username}".`);
      await refresh();
    } catch {
      setError("Unable to set passcode right now.");
    } finally {
      setBusyUsername(null);
    }
  };

  const toggleActive = async (account: AdminAccountRow) => {
    setBusyUsername(account.username);
    setError(null);
    try {
      const response = await fetch(`/api/admin/team/${encodeURIComponent(account.username)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !account.isActive }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error ?? "Unable to update account.");
        return;
      }
      await refresh();
    } catch {
      setError("Unable to update account right now.");
    } finally {
      setBusyUsername(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">New admin account</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-zinc-300">
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
          <label className="text-sm text-zinc-300">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" placeholder="At least 12 characters" />
          </label>
          <label className="text-sm text-zinc-300">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as AdminRole)} className="vl-input mt-1 w-full px-3 py-2">
              {ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option.replace("_", " ")}</option>
              ))}
            </select>
          </label>
        </div>
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-emerald-300">{message}</p> : null}
        <button type="button" onClick={handleCreate} disabled={creating} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {creating ? "Creating…" : "Create account"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">All accounts ({accounts.length})</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="pb-2 pr-4">Username</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Passcode</th>
                <th className="pb-2 pr-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id} className="border-t border-white/10">
                  <td className="py-3 pr-4 text-zinc-100">
                    {account.username}
                    {account.username === currentUsername ? <span className="ml-2 text-xs text-zinc-500">(you)</span> : null}
                  </td>
                  <td className="py-3 pr-4">
                    <select
                      value={account.role}
                      onChange={(e) => changeRole(account, e.target.value as AdminRole)}
                      disabled={busyUsername === account.username}
                      className="vl-input px-2 py-1 text-sm disabled:opacity-60"
                    >
                      {ROLE_OPTIONS.map((option) => (
                        <option key={option} value={option}>{option.replace("_", " ")}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={account.isActive ? "rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300" : "rounded-full bg-zinc-500/15 px-2 py-1 text-xs text-zinc-400"}>
                      {account.isActive ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <span className={account.hasPasscode ? "rounded-full bg-emerald-400/15 px-2 py-1 text-xs text-emerald-300" : "rounded-full bg-amber-400/15 px-2 py-1 text-xs text-amber-300"}>
                      {account.hasPasscode ? "Set" : "Not set"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setPasscode(account)}
                        disabled={busyUsername === account.username}
                        className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        {account.hasPasscode ? "Change passcode" : "Set passcode"}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(account)}
                        disabled={busyUsername === account.username || account.username === currentUsername}
                        className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
                      >
                        {account.isActive ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-zinc-500">No admin accounts yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
