"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import type { CustomerPreferences, CustomerAddress } from "@/lib/customer-account";
import { AccountAddressesClient } from "@/components/account-addresses-client";
import Link from "next/link";

type Category = "profile" | "security" | "addresses" | "payments" | "notifications" | "privacy";

const CATEGORIES: Array<{ key: Category; label: string }> = [
  { key: "profile", label: "Profile" },
  { key: "security", label: "Security" },
  { key: "addresses", label: "Addresses" },
  { key: "payments", label: "Payments" },
  { key: "notifications", label: "Notifications" },
  { key: "privacy", label: "Privacy" },
];

export function AccountSettingsClient({
  initialFullName,
  initialEmail,
  initialPreferences,
  initialAddresses,
  // FALSE ONLY FOR AN ACCOUNT THAT SIGNED UP THROUGH A PROVIDER.
  //
  // Such an account has no password identity, so every control on this page
  // that asks for a "current password" is asking for something that does not
  // exist. Rather than let those controls fail with "Current password is
  // incorrect" — false, and unactionable — the two that depend on one change
  // shape: the password card sets a first password, and the email card explains
  // that it needs one first.
  hasPassword = true,
}: {
  initialFullName: string;
  initialEmail: string;
  initialPreferences: CustomerPreferences;
  initialAddresses: CustomerAddress[];
  hasPassword?: boolean;
}) {
  const [category, setCategory] = useState<Category>("profile");

  const [fullName, setFullName] = useState(initialFullName);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPreferences.phone ?? "");
  const [emailChangePassword, setEmailChangePassword] = useState("");
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
      if (fullName.trim() !== initialFullName) updates.data = { full_name: fullName.trim() };
      if (email.trim().toLowerCase() !== initialEmail.toLowerCase()) updates.email = email.trim();
      const phoneChanged = phone.trim() !== (initialPreferences.phone ?? "");

      if (Object.keys(updates).length === 0 && !phoneChanged) {
        setProfileMessage("Nothing to update.");
        return;
      }

      // Changing the email is security-sensitive: the current password has to
      // be re-checked so a hijacked open session can't silently take over the
      // account. This used to call signInWithPassword right here, which read
      // like the control and was not one — the route it guarded never asked for
      // a password, so anyone holding the session cookie could skip the browser
      // entirely and POST straight to it. The check now happens in
      // /api/account/email-change, server-side, where a caller cannot reach it;
      // all this does is stop the customer making a round trip to be told they
      // left the field blank.
      if (updates.email && initialEmail && !emailChangePassword) {
        setProfileError(
          hasPassword
            ? "Enter your current password to change your email."
            : "Your account signs in with Google, so it has no password yet. Add one under Security first, then you can change your email.",
        );
        return;
      }

      // THE EMAIL CHANGE GOES THROUGH THE SERVER, SO ITS EMAIL IS OURS.
      //
      // supabase.auth.updateUser({ email }) makes GoTrue mail its own unstyled
      // template, from Supabase's identity, with a button pointing at
      // <project>.supabase.co — unbranded, off-domain, invisible to the send
      // log and the bounce webhook. That is the message shape Gmail filed as
      // spam on 2026-08-29, stripping the links so there was nothing to click,
      // and it was the last customer-facing auth email still sent that way.
      // /api/account/email-change mints the same link with the admin API and
      // sends it branded instead. GoTrue still owns the change itself.
      //
      // The name is a plain profile write with no email attached, so it stays
      // here.
      let emailChangeMessage: string | null = null;
      if (updates.data) {
        const { error } = await supabase.auth.updateUser({ data: updates.data });
        if (error) throw new Error(error.message);
      }

      if (updates.email) {
        const response = await fetch("/api/account/email-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: updates.email, currentPassword: emailChangePassword }),
        });
        const result = (await response.json().catch(() => null)) as
          | { success: boolean; message?: string; error?: string }
          | null;
        if (!response.ok || !result?.success) {
          throw new Error(result?.error ?? "Unable to start that email change.");
        }
        emailChangeMessage = result.message ?? null;
      }

      if (phoneChanged) {
        const response = await fetch("/api/account/phone", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phone.trim() }),
        });
        const result = (await response.json()) as { success: boolean; error?: string };
        if (!result.success) throw new Error(result.error ?? "Unable to save phone number.");
      }

      // Quote the route's own sentence when there is one: it names the address
      // the link went to, and says the account keeps its current address until
      // the link is followed.
      setProfileMessage(
        emailChangeMessage
          ?? (updates.email ? "Profile updated. Check your new email address to confirm the change." : "Profile updated."),
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
      // THROUGH THE SERVER, BECAUSE THAT IS THE ONLY PLACE THE RULES HOLD.
      //
      // This used to check the length here and then call
      // supabase.auth.signInWithPassword + supabase.auth.updateUser from the
      // browser. Both of those are the caller's own code: anyone holding a
      // stolen session token could call updateUser directly, skip the
      // re-authentication entirely, and set a new password without knowing the
      // old one — locking the real owner out, which is exactly what the
      // re-authentication was there to prevent. The length rule went with it.
      //
      // /api/account/change-password verifies the current password server-side,
      // enforces the minimum where the caller cannot reach it, and signs the
      // account's other devices out the way the reset form already did.
      const response = await fetch("/api/account/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const result = (await response.json().catch(() => null)) as
        | { success: boolean; message?: string; error?: string }
        | null;
      if (!response.ok || !result?.success) {
        throw new Error(result?.error ?? "Unable to update password");
      }
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMessage(result.message ?? "Password updated.");
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
      const result = (await response.json()) as { success: boolean; error?: string };
      setPreferencesMessage(result.success ? "Preferences saved." : result.error ?? "Unable to save preferences.");
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
      const result = (await response.json()) as { success: boolean; error?: string };
      setBirthdayMessage(result.success ? "Birthday saved. We'll send a bonus on your next one!" : result.error ?? "Unable to save birthday.");
    } catch {
      setBirthdayMessage("Unable to save birthday right now.");
    } finally {
      setSavingBirthday(false);
    }
  };

  const emailChanged = email.trim().toLowerCase() !== initialEmail.toLowerCase() && Boolean(initialEmail);

  return (
    <div className="space-y-5">
      {/* Category switcher */}
      <nav aria-label="Settings categories" className="vl-panel rounded-2xl p-2">
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CATEGORIES.map((c) => {
            const active = category === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setCategory(c.key)}
                aria-current={active ? "true" : undefined}
                className={`vl-focus-ring shrink-0 rounded-xl px-4 py-2.5 text-sm transition-colors duration-200 ${
                  active ? "border border-cyan-300/40 bg-cyan-400/15 font-semibold text-cyan-100" : "border border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Profile */}
      {category === "profile" ? (
        <div className="space-y-5">
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
              <label className="text-sm text-zinc-300">
                Phone <span className="text-zinc-500">(optional)</span>
                <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" autoComplete="tel" className="vl-input mt-1 w-full px-3 py-2" />
              </label>
            </div>
            {emailChanged ? (
              <label className="mt-3 block text-sm text-zinc-300 sm:max-w-sm">
                Current password (required to change email)
                <input type="password" value={emailChangePassword} onChange={(e) => setEmailChangePassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" autoComplete="current-password" />
              </label>
            ) : null}
            {profileError ? <p className="mt-3 text-sm text-rose-300">{profileError}</p> : null}
            {profileMessage ? <p className="mt-3 text-sm text-emerald-300">{profileMessage}</p> : null}
            <button type="button" onClick={handleSaveProfile} disabled={savingProfile} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
              {savingProfile ? "Saving…" : "Save profile"}
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
        </div>
      ) : null}

      {/* Security */}
      {category === "security" ? (
        <div className="space-y-5">
          <section className="vl-panel rounded-2xl p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-white">{hasPassword ? "Change password" : "Add a password"}</h2>
            {hasPassword ? null : (
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                You sign in with Google, so this account has no password yet. Setting one lets you
                sign in either way — and it is required before you can change your email address.
              </p>
            )}
            <div className={`mt-4 grid gap-3 ${hasPassword ? "sm:grid-cols-2" : ""}`}>
              {hasPassword ? (
                <label className="text-sm text-zinc-300">
                  Current password
                  <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" autoComplete="current-password" />
                </label>
              ) : null}
              <label className="text-sm text-zinc-300">
                New password
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" autoComplete="new-password" minLength={8} />
              </label>
            </div>
            {passwordError ? <p className="mt-3 text-sm text-rose-300">{passwordError}</p> : null}
            {passwordMessage ? <p className="mt-3 text-sm text-emerald-300">{passwordMessage}</p> : null}
            <button type="button" onClick={handleChangePassword} disabled={savingPassword} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
              {savingPassword ? "Saving…" : hasPassword ? "Update password" : "Set password"}
            </button>
          </section>

        </div>
      ) : null}

      {/* Addresses */}
      {category === "addresses" ? <AccountAddressesClient initialAddresses={initialAddresses} /> : null}

      {/* Payments */}
      {category === "payments" ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Saved payment methods</h2>
          <div className="mt-4 rounded-xl border border-dashed border-white/12 bg-white/[0.02] p-6 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-cyan-200">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" />
              </svg>
            </div>
            <p className="mt-3 text-sm font-medium text-white">Secure checkout is arriving soon</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-zinc-500">
              Once our payment processor is connected, you&apos;ll be able to securely save cards here for one-tap checkout and membership billing. Your card details are never stored on our servers.
            </p>
          </div>
        </section>
      ) : null}

      {/* Notifications */}
      {category === "notifications" ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Email notifications</h2>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-zinc-400">
              Order confirmations, payment receipts, and shipping updates are always sent — these keep you informed about purchases you make.
            </p>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-200">
              <span>
                Product news and promotions
                <span className="mt-0.5 block text-xs text-zinc-500">New drops, restocks, and member offers.</span>
              </span>
              <input
                type="checkbox"
                checked={preferences.marketingEmails}
                onChange={(e) => setPreferences((prev) => ({ ...prev, marketingEmails: e.target.checked }))}
                className="h-5 w-5 shrink-0 accent-cyan-400"
              />
            </label>
          </div>
          {preferencesMessage ? <p className="mt-3 text-sm text-zinc-300">{preferencesMessage}</p> : null}
          <button type="button" onClick={handleSavePreferences} disabled={savingPreferences} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
            {savingPreferences ? "Saving…" : "Save preferences"}
          </button>
        </section>
      ) : null}

      {/* Privacy */}
      {category === "privacy" ? (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Privacy &amp; data</h2>
          <p className="mt-2 text-sm text-zinc-400">
            You control your data. Request a copy of the information we hold, or ask us to delete your account and personal data.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <a
              href={`mailto:support@vantalabsresearch.com?subject=${encodeURIComponent("Data export request")}&body=${encodeURIComponent(`Please send me a copy of the data associated with my account (${initialEmail}).`)}`}
              className="vl-focus-ring rounded-xl border border-white/10 bg-white/[0.02] p-4 transition-colors duration-200 hover:border-white/25"
            >
              <p className="text-sm font-medium text-white">Download my data</p>
              <p className="mt-1 text-xs text-zinc-500">Request a copy of your account information.</p>
            </a>
            <a
              href={`mailto:support@vantalabsresearch.com?subject=${encodeURIComponent("Account deletion request")}&body=${encodeURIComponent(`Please delete my account and associated personal data (${initialEmail}).`)}`}
              className="vl-focus-ring rounded-xl border border-rose-400/20 bg-rose-400/[0.03] p-4 transition-colors duration-200 hover:border-rose-400/40"
            >
              <p className="text-sm font-medium text-rose-200">Delete my account</p>
              <p className="mt-1 text-xs text-zinc-500">Permanently remove your account and data.</p>
            </a>
          </div>
          <p className="mt-4 border-t border-white/10 pt-3 text-[11px] leading-5 text-zinc-500">
            See our <Link href="/legal/privacy" className="text-cyan-300 underline-offset-2 hover:underline">Privacy Policy</Link> for how we handle and protect your data.
          </p>
        </section>
      ) : null}
    </div>
  );
}
