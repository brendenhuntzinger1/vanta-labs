"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CustomerPreferences } from "@/lib/customer-account";

export function AccountSettingsClient({
  initialFullName,
  initialEmail,
  initialPreferences,
}: {
  initialFullName: string;
  initialEmail: string;
  initialPreferences: CustomerPreferences;
}) {
  const [fullName, setFullName] = useState(initialFullName);
  const [email, setEmail] = useState(initialEmail);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [preferences, setPreferences] = useState(initialPreferences);
  const [birthday, setBirthday] = useState(initialPreferences.birthday ?? "");
  const [savingBirthday, setSavingBirthday] = useState(false);
  const [birthdayMessage, setBirthdayMessage] = useState<string | null>(null);

  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [savingPreferences, setSavingPreferences] = useState(false);
  const [preferencesMessage, setPreferencesMessage] = useState<string | null>(null);

  const handleSaveProfile = async () => {
    setSavingProfile(true);
    setProfileMessage(null);
    setProfileError(null);

    try {
      const updates: { data?: { full_name: string }; email?: string } = {};
      if (fullName.trim() !== initialFullName) {
        updates.data = { full_name: fullName.trim() };
      }
      if (email.trim().toLowerCase() !== initialEmail.toLowerCase()) {
        updates.email = email.trim();
      }

      if (Object.keys(updates).length === 0) {
        setProfileMessage("Nothing to update.");
        return;
      }

      const { error } = await supabase.auth.updateUser(updates);
      if (error) {
        throw new Error(error.message);
      }

      setProfileMessage(
        updates.email
          ? "Profile updated. Check your new email address to confirm the change."
          : "Profile updated.",
      );
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Unable to update profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    setSavingPassword(true);
    setPasswordMessage(null);
    setPasswordError(null);

    try {
      if (newPassword.length < 8) {
        throw new Error("New password must be at least 8 characters.");
      }

      // Re-authenticate with the current password before applying a change,
      // since updateUser() alone would let anyone with a hijacked open
      // session silently lock the real owner out.
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: initialEmail,
        password: currentPassword,
      });
      if (reauthError) {
        throw new Error("Current password is incorrect.");
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        throw new Error(error.message);
      }

      setCurrentPassword("");
      setNewPassword("");
      setPasswordMessage("Password updated.");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Unable to update password");
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSavePreferences = async () => {
    setSavingPreferences(true);
    setPreferencesMessage(null);

    try {
      const response = await fetch("/api/account/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      const result = await response.json() as { success: boolean; error?: string };
      if (!result.success) {
        setPreferencesMessage(result.error ?? "Unable to save preferences.");
        return;
      }
      setPreferencesMessage("Preferences saved.");
    } catch {
      setPreferencesMessage("Unable to save preferences right now.");
    } finally {
      setSavingPreferences(false);
    }
  };

  const handleSaveBirthday = async () => {
    setSavingBirthday(true);
    setBirthdayMessage(null);

    try {
      const response = await fetch("/api/account/birthday", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthday }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setBirthdayMessage(result.success ? "Birthday saved. We'll send a bonus on your next one!" : (result.error ?? "Unable to save birthday."));
    } catch {
      setBirthdayMessage("Unable to save birthday right now.");
    } finally {
      setSavingBirthday(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Profile</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-300">
            Full name
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
          <label className="text-sm text-zinc-300">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" />
          </label>
        </div>
        {profileError ? <p className="mt-3 text-sm text-rose-300">{profileError}</p> : null}
        {profileMessage ? <p className="mt-3 text-sm text-emerald-300">{profileMessage}</p> : null}
        <button type="button" onClick={handleSaveProfile} disabled={savingProfile} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingProfile ? "Saving…" : "Save profile"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Change password</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-300">
            Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" autoComplete="current-password" />
          </label>
          <label className="text-sm text-zinc-300">
            New password
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" autoComplete="new-password" minLength={8} />
          </label>
        </div>
        {passwordError ? <p className="mt-3 text-sm text-rose-300">{passwordError}</p> : null}
        {passwordMessage ? <p className="mt-3 text-sm text-emerald-300">{passwordMessage}</p> : null}
        <button type="button" onClick={handleChangePassword} disabled={savingPassword} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingPassword ? "Updating…" : "Update password"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Birthday</h2>
        <p className="mt-1 text-sm text-zinc-400">Optional — add your birthday for a rewards bonus on the day.</p>
        <label className="mt-4 block text-sm text-zinc-300 sm:max-w-xs">
          <input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
        {birthdayMessage ? <p className="mt-3 text-sm text-zinc-300">{birthdayMessage}</p> : null}
        <button type="button" onClick={handleSaveBirthday} disabled={savingBirthday || !birthday} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingBirthday ? "Saving…" : "Save birthday"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Email notifications</h2>
        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={preferences.orderUpdateEmails}
              onChange={(e) => setPreferences((prev) => ({ ...prev, orderUpdateEmails: e.target.checked }))}
            />
            Order confirmations and shipping updates
          </label>
          <label className="flex items-center gap-3 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={preferences.marketingEmails}
              onChange={(e) => setPreferences((prev) => ({ ...prev, marketingEmails: e.target.checked }))}
            />
            Product news and promotions
          </label>
        </div>
        {preferencesMessage ? <p className="mt-3 text-sm text-zinc-300">{preferencesMessage}</p> : null}
        <button type="button" onClick={handleSavePreferences} disabled={savingPreferences} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingPreferences ? "Saving…" : "Save preferences"}
        </button>
      </section>
    </div>
  );
}
