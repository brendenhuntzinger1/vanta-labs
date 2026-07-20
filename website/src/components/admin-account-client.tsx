"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminAccountClient({ username }: { username: string }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const call = async (action: string, extra: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, currentPassword, ...extra }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage({ tone: "err", text: json.error ?? "Failed." });
        return false;
      }
      return true;
    } catch {
      setMessage({ tone: "err", text: "Failed." });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 12) return setMessage({ tone: "err", text: "New password must be at least 12 characters." });
    if (newPassword !== confirmPassword) return setMessage({ tone: "err", text: "New passwords don't match." });
    if (await call("change_password", { newPassword })) {
      setMessage({ tone: "ok", text: "Password changed." });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    }
  };

  const changeUsername = async () => {
    if (!newUsername.trim()) return setMessage({ tone: "err", text: "Enter a new username." });
    if (await call("change_username", { newUsername })) {
      setMessage({ tone: "ok", text: `Username changed to ${newUsername.trim().toLowerCase()}.` });
      setCurrentPassword(""); setNewUsername("");
      router.refresh();
    }
  };

  return (
    <div className="mt-6 space-y-4">
      <div className="vl-panel rounded-2xl p-5">
        <h2 className="text-lg font-semibold">Change password</h2>
        <p className="mt-1 text-sm text-zinc-400">You&apos;re signed in as <span className="text-zinc-200">{username}</span>. Enter your current password to make changes.</p>
        <div className="mt-4 grid max-w-md gap-3">
          <label className="text-xs text-zinc-400">Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-zinc-400">New password (min 12 chars)
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-zinc-400">Confirm new password
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <button type="button" disabled={busy} onClick={changePassword} className="vl-btn-primary mt-1 w-fit px-4 py-2 text-xs disabled:opacity-50">Update password</button>
        </div>
      </div>

      <div className="vl-panel rounded-2xl p-5">
        <h2 className="text-lg font-semibold">Change username</h2>
        <div className="mt-4 grid max-w-md gap-3">
          <label className="text-xs text-zinc-400">Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-zinc-400">New username
            <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="new-username" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
          </label>
          <button type="button" disabled={busy} onClick={changeUsername} className="vl-btn-secondary mt-1 w-fit px-4 py-2 text-xs disabled:opacity-50">Update username</button>
        </div>
      </div>

      {message ? <p className={`text-sm ${message.tone === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p> : null}
    </div>
  );
}
