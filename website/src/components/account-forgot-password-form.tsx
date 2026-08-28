"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { TurnstileWidget } from "@/components/turnstile-widget";

// Every other auth call in the app (signup, password login, phone OTP) carries
// a Turnstile token. This one did not, and password reset is the single path a
// locked-out user has left. Turnstile is currently unconfigured in production,
// so the omission was dormant — but the moment a secret is set in the Supabase
// dashboard, Auth starts rejecting tokenless calls and reset would break for
// EVERY user, silently, with no code change to point at. Wiring it now means
// enabling the CAPTCHA is a config change rather than an outage.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";

function getEmailRedirectUrl(path: string) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (siteUrl) {
    return `${siteUrl.replace(/\/+$/, "")}${path}`;
  }

  if (typeof window !== "undefined") {
    return `${window.location.origin}${path}`;
  }

  return undefined;
}

export function AccountForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Single-use token; the bump counter re-renders the widget after each attempt.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: getEmailRedirectUrl("/account/reset-password"),
        captchaToken: captchaToken ?? undefined,
      });

      if (resetError) {
        throw new Error(resetError.message);
      }

      setMessage("If an account exists for that email, a password reset link is on its way. It can take a minute — check your spam folder too.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to send reset email");
    } finally {
      setLoading(false);
      if (TURNSTILE_SITE_KEY) {
        setCaptchaToken(null);
        setCaptchaResetKey((key) => key + 1);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 sm:p-8">
      <p className="text-[11px] uppercase tracking-[0.35em] text-zinc-300">My Account</p>
      <h1 className="mt-3 text-3xl font-semibold text-white">Reset your password</h1>
      <p className="mt-2 text-sm text-zinc-400">Enter your account email and we&apos;ll send a reset link.</p>

      <label className="mt-6 block text-sm text-zinc-400">
        <span className="mb-2 block">Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="vl-input w-full px-4 py-3"
          autoComplete="email"
          required
        />
      </label>

      {TURNSTILE_SITE_KEY ? (
        <TurnstileWidget siteKey={TURNSTILE_SITE_KEY} onToken={setCaptchaToken} resetKey={captchaResetKey} />
      ) : null}

      {message ? <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</p> : null}
      {error ? <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sending…" : "Send reset link"}
      </button>
    </form>
  );
}
