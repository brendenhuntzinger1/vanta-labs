"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { isPasswordSetupLink } from "@/lib/auth-link-fragment";
import { MIN_PASSWORD_LENGTH, MIN_PASSWORD_MESSAGE } from "@/lib/password-policy";

// ---------------------------------------------------------------------------
// SURVIVING A RELOAD.
//
// The gate below is satisfied by two signals and both are one-shot: the
// `type=recovery|invite` fragment, and the PASSWORD_RECOVERY event. auth-js
// clears the fragment the moment it consumes the link (`window.location.hash =
// ''` in _getSessionFromURL) and only ever emits PASSWORD_RECOVERY from that
// same function, so a reload emits INITIAL_SESSION instead and sees an empty
// hash.
//
// So refreshing this page — or a password manager reloading it, or coming back
// after a validation error — rendered "This reset link is invalid or has
// expired" on a recovery session that was perfectly live and would have
// accepted a new password. The customer is told to request another link, and
// the next one lands them in exactly the same place.
//
// sessionStorage is the right store for the marker, deliberately not
// localStorage: it survives the reload, dies with the tab, and is not shared
// with any other tab — so it cannot outlive the recovery it belongs to or
// unlock this form for the browser's next occupant. It is only ever WRITTEN
// after a real recovery signal, only ever HONOURED alongside a live session,
// and cleared as soon as the password is set.
// ---------------------------------------------------------------------------
const RECOVERY_MARKER = "vl:password-recovery";

/** Every access is wrapped: Safari private mode throws on sessionStorage. */
function markRecoveryInProgress() {
  try {
    window.sessionStorage.setItem(RECOVERY_MARKER, "1");
  } catch {
    // No marker means the pre-existing behaviour, not a broken form.
  }
}

function recoveryInProgress(): boolean {
  try {
    return window.sessionStorage.getItem(RECOVERY_MARKER) === "1";
  } catch {
    return false;
  }
}

function clearRecoveryMarker() {
  try {
    window.sessionStorage.removeItem(RECOVERY_MARKER);
  } catch {
    // Nothing to do; the marker is only ever an unlock, never a grant.
  }
}

export function AccountResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasRecoverySession, setHasRecoverySession] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // WHAT THIS CHECK ACTUALLY DOES, AND WHAT IT DOES NOT (audit E2).
    //
    // It keeps a NORMALLY SIGNED-IN visitor off this form, so the only way to
    // reach a no-current-password change is to arrive from a recovery link.
    // That is a real and useful property: /account/settings re-authenticates
    // before changing a password, and without this gate a signed-in session
    // would silently bypass that by visiting this URL.
    //
    // It is NOT a defence against a stolen session. The fragment is client
    // supplied and nothing here can verify it, so anyone holding a victim's
    // tokens can hand-build one — and in any case they could call
    // supabase.auth.updateUser({ password }) directly and skip this page
    // entirely. This page is not, and cannot be, that boundary. The control
    // that IS one is GoTrue's "secure password change" setting (require recent
    // re-authentication), configured on the Supabase project; see
    // docs/findings/EMAIL-AUTH-AUDIT-2026-08-28.md.
    //
    // The earlier version also accepted a bare `access_token=` in the hash,
    // which matches a SIGNUP confirmation redirect as readily as a recovery
    // one. Only the explicit password-setup markers are accepted now.
    //
    // TWO OF THEM, NOT ONE. `invite` is how an admin-invited ambassador
    // arrives, and auth.admin.inviteUserByEmail creates that account with NO
    // password — so this form is the only thing that can ever give them one.
    // Accepting only `recovery` left the whole invite path a dead end; see
    // lib/auth-link-fragment.ts. `signup` is still refused: a confirmation
    // redirect carries an access_token too, and it is not a password-setup
    // link.
    //
    // Read synchronously, before any await: Supabase strips the fragment once
    // it has consumed it, so this is the only moment it is reliably present.
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const looksLikePasswordSetupLink = isPasswordSetupLink(hash);

    if (looksLikePasswordSetupLink) {
      markRecoveryInProgress();
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && active) {
        markRecoveryInProgress();
        setHasRecoverySession(true);
      }
    });

    (async () => {
      // Give Supabase a moment to process the recovery token in the URL, then
      // decide. A live session that did NOT arrive via a recovery link is
      // rejected (the user is sent to forgot-password to get a real link).
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      // Never downgrade a PASSWORD_RECOVERY event that has already fired: the
      // event is the stronger signal, and Supabase strips the fragment once it
      // has consumed it, so the hash may legitimately be empty by now.
      // A live session PLUS evidence this tab is mid-recovery. The evidence is
      // the fragment on the first load and the sessionStorage marker on every
      // load after it; requiring the session as well means a stale marker can
      // never unlock the form on its own.
      const evidence = looksLikePasswordSetupLink || recoveryInProgress();
      setHasRecoverySession((current) => current === true || (Boolean(data.session) && evidence));
    })();

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(MIN_PASSWORD_MESSAGE);
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        throw new Error(updateError.message);
      }

      // Someone resetting their password is very often doing it BECAUSE they
      // think someone else has been in the account. Revoking every other
      // session makes the new password mean what they expect it to mean;
      // leaving them live means the intruder keeps their access. Best-effort:
      // this must never turn a successful reset into a visible failure.
      await supabase.auth.signOut({ scope: "others" }).catch(() => {});

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      const refreshToken = data.session?.refresh_token ?? null;

      if (accessToken) {
        await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken, refreshToken }),
        });
      }

      // The recovery is over. Leaving the marker would unlock this form for the
      // rest of the tab's life on an ordinary signed-in session — the exact
      // bypass the gate exists to prevent.
      clearRecoveryMarker();

      router.push("/account");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to reset password");
    } finally {
      setLoading(false);
    }
  };

  if (hasRecoverySession === false) {
    return (
      <div className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 text-center sm:p-8">
        <p className="text-sm text-zinc-300">
          This reset link is invalid or has expired. Request a new one from the{" "}
          <Link href="/account/forgot-password" className="text-cyan-300 underline-offset-4 hover:underline">forgot password</Link> page.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 sm:p-8">
      <p className="text-[11px] uppercase tracking-[0.35em] text-zinc-300">My Account</p>
      <h1 className="mt-3 text-3xl font-semibold text-white">Choose a new password</h1>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-zinc-400">
          <span className="mb-2 block">New password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="vl-input w-full px-4 py-3"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <label className="block text-sm text-zinc-400">
          <span className="mb-2 block">Confirm password</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="vl-input w-full px-4 py-3"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
      </div>

      {error ? <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
