"use client";

import Link from "next/link";
import { useState } from "react";
import { TurnstileWidget } from "@/components/turnstile-widget";

// Every other auth call in the app (signup, password login, phone OTP) carries
// a Turnstile token. This one did not, and password reset is the single path a
// locked-out user has left. Turnstile is currently unconfigured in production,
// so the omission was dormant — but the moment a secret is set, tokenless calls
// start being rejected and reset would break for EVERY user, silently, with no
// code change to point at. Wiring it means enabling the CAPTCHA is a config
// change rather than an outage.
//
// The token now goes to OUR route, which verifies it against Cloudflare
// directly (see lib/turnstile.ts). It used to be handed to Supabase, which
// checked it only if CAPTCHA protection happened to be enabled there.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";

// Shown for every outcome — an address with an account, one without, a send
// that failed, a rate limit on this specific address. Anything that varied
// would make this form an account-enumeration oracle. See the route.
const GENERIC_SENT_MESSAGE =
  "If an account exists for that email, a password reset link is on its way. It can take a minute — check your spam folder too.";

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
      // POST to our own route rather than calling Supabase from the browser, so
      // the reset email goes out through the same provider, template, bounce
      // webhook and retry queue as every other transactional message (audit E1).
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), captchaToken: captchaToken ?? undefined }),
      });
      const json = await response.json().catch(() => ({}));

      // The route answers 200 for every ordinary outcome. A non-OK status is a
      // real refusal the visitor can act on — rate limited, or CAPTCHA failed.
      if (!response.ok) {
        throw new Error(json?.error ?? "Unable to send reset email");
      }

      setMessage(GENERIC_SENT_MESSAGE);
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

      {message ? <p role="status" className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</p> : null}
      {error ? <p role="alert" className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sending…" : "Send reset link"}
      </button>

      {/* This page had no way back. Someone who lands here by mistake, or who
          remembers their password while reading it, was left with the browser's
          back button and a header logo. */}
      <p className="mt-6 border-t border-white/10 pt-5 text-center text-sm text-zinc-400">
        Remembered it?{" "}
        <Link
          href="/account/login"
          className="vl-focus-ring inline-flex min-h-6 items-center rounded-[6px] font-medium text-cyan-300 underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
