"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type AuthMode = "login" | "signup";
type AuthMethod = "email" | "phone";

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

function safeNextPath(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  return "/account";
}

export function AccountAuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCodeFromUrl = searchParams.get("ref") ?? "";
  const nextPath = safeNextPath(searchParams.get("next"));
  const [mode, setMode] = useState<AuthMode>(referralCodeFromUrl ? "signup" : "login");
  const [method, setMethod] = useState<AuthMethod>("email");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [completingVerification, setCompletingVerification] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A shopper who clicked the confirmation link in Supabase's built-in
  // verification email lands back here with a session already established
  // by the Supabase client (it reads the token from the URL fragment) -
  // finish signing them in by setting our own httpOnly session cookie.
  useEffect(() => {
    let active = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      const user = data.session?.user;

      if (!accessToken || !user) {
        return;
      }

      // Complete the session for any shopper — admins/partners have their own
      // portals, but a role-less or phone-OTP account is a customer and must
      // finish signing in (mirrors detectRoleFromUser's default-to-customer).
      const role = String(user.app_metadata?.role ?? user.user_metadata?.role ?? "").toLowerCase();
      if (role === "admin" || role === "partner" || role === "ambassador") {
        return;
      }

      if (active) {
        setCompletingVerification(true);
      }

      try {
        const sessionResponse = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken }),
        });
        const sessionJson = await sessionResponse.json();
        if (!sessionResponse.ok || !sessionJson.success) {
          throw new Error(sessionJson.error ?? "Unable to establish session");
        }

        router.push(nextPath);
        router.refresh();
      } catch (verifyError) {
        if (active) {
          setError(verifyError instanceof Error ? verifyError.message : "Unable to complete email verification");
        }
      } finally {
        if (active) {
          setCompletingVerification(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [router, nextPath]);

  const establishSessionAndGo = async (accessToken: string) => {
    const sessionResponse = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken }),
    });
    const sessionJson = await sessionResponse.json();
    if (!sessionResponse.ok || !sessionJson.success) {
      throw new Error(sessionJson.error ?? "Unable to establish session");
    }
    router.push(nextPath);
    router.refresh();
  };

  const handleSignup = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
            role: "customer",
            referred_by_code: referralCodeFromUrl || undefined,
          },
          emailRedirectTo: getEmailRedirectUrl(`/account/login?next=${encodeURIComponent(nextPath)}`),
        },
      });

      if (signUpError || !data.user) {
        throw new Error(signUpError?.message ?? "Unable to create account");
      }

      if (!data.session?.access_token) {
        setMessage("Check your email to confirm your account, then come back and sign in.");
        return;
      }

      await establishSessionAndGo(data.session.access_token);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create account");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError || !data.session?.access_token) {
        throw new Error(signInError?.message ?? "Unable to sign in");
      }

      await establishSessionAndGo(data.session.access_token);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  };

  // Phone auth (SMS one-time code). Requires an SMS provider (e.g. Twilio)
  // configured in the Supabase dashboard for texts to actually send.
  const handleSendCode = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const normalizedPhone = phone.trim();
      const { error: otpError } = await supabase.auth.signInWithOtp({
        phone: normalizedPhone,
        options: mode === "signup"
          ? {
              shouldCreateUser: true,
              data: {
                full_name: fullName.trim(),
                role: "customer",
                referred_by_code: referralCodeFromUrl || undefined,
              },
            }
          : { shouldCreateUser: false },
      });

      if (otpError) {
        throw new Error(otpError.message);
      }

      setOtpSent(true);
      setMessage("We sent a 6-digit code to your phone. Enter it below to continue.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to send code");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({
        phone: phone.trim(),
        token: otpCode.trim(),
        type: "sms",
      });

      if (verifyError || !data.session?.access_token) {
        throw new Error(verifyError?.message ?? "Invalid or expired code");
      }

      await establishSessionAndGo(data.session.access_token);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to verify code");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    if (method === "phone") {
      void (otpSent ? handleVerifyCode() : handleSendCode());
      return;
    }
    void (mode === "signup" ? handleSignup() : handleLogin());
  };

  const resetTransientState = () => {
    setError(null);
    setMessage(null);
    setOtpSent(false);
    setOtpCode("");
  };

  if (completingVerification) {
    return (
      <div className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 text-center sm:p-8">
        <p className="text-sm text-zinc-300">Confirming your account…</p>
      </div>
    );
  }

  const primaryLabel = method === "phone"
    ? (otpSent ? "Verify code" : "Send code")
    : (mode === "signup" ? "Create Account" : "Sign In");

  return (
    <form onSubmit={handleSubmit} className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 sm:p-8">
      <p className="text-[11px] uppercase tracking-[0.35em] text-zinc-300">My Account</p>
      <h1 className="mt-3 text-3xl font-semibold text-white">{mode === "signup" ? "Create your account" : "Sign In"}</h1>
      <p className="mt-2 text-sm text-zinc-400">
        {mode === "signup"
          ? "Track orders, save addresses, and check out faster."
          : "Access your order history, saved addresses, and wishlist."}
      </p>

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={() => { setMethod("email"); resetTransientState(); }}
          className={method === "email"
            ? "flex-1 rounded-xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-3 text-sm font-semibold text-cyan-100"
            : "flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300 transition hover:text-white"}
        >
          Email
        </button>
        <button
          type="button"
          onClick={() => { setMethod("phone"); resetTransientState(); }}
          className={method === "phone"
            ? "flex-1 rounded-xl border border-cyan-300/40 bg-cyan-400/15 px-4 py-3 text-sm font-semibold text-cyan-100"
            : "flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-zinc-300 transition hover:text-white"}
        >
          Phone
        </button>
      </div>

      <div className="mt-5 space-y-4">
        {mode === "signup" ? (
          <label className="block text-sm text-zinc-400">
            <span className="mb-2 block">Full name</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="vl-input w-full px-4 py-3"
              autoComplete="name"
              required
            />
          </label>
        ) : null}

        {method === "email" ? (
          <>
            <label className="block text-sm text-zinc-400">
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

            <label className="block text-sm text-zinc-400">
              <span className="mb-2 block">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="vl-input w-full px-4 py-3"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={8}
                required
              />
            </label>
          </>
        ) : (
          <>
            <label className="block text-sm text-zinc-400">
              <span className="mb-2 block">Phone number</span>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="vl-input w-full px-4 py-3"
                autoComplete="tel"
                placeholder="+1 555 123 4567"
                disabled={otpSent}
                required
              />
              <span className="mt-1 block text-xs text-zinc-500">Include your country code, e.g. +1 for the US.</span>
            </label>

            {otpSent ? (
              <label className="block text-sm text-zinc-400">
                <span className="mb-2 block">6-digit code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value)}
                  className="vl-input w-full px-4 py-3 tracking-[0.4em]"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                />
                <button
                  type="button"
                  onClick={() => { setOtpSent(false); setOtpCode(""); }}
                  className="vl-focus-ring mt-2 text-xs text-zinc-400 underline-offset-4 hover:underline"
                >
                  Use a different number
                </button>
              </label>
            ) : null}
          </>
        )}
      </div>

      {message ? <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</p> : null}
      {error ? <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-white to-zinc-300 px-6 py-3 text-sm font-bold text-zinc-950 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Please wait…" : primaryLabel}
      </button>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-zinc-500">
        <button
          type="button"
          onClick={() => {
            setMode((current) => (current === "signup" ? "login" : "signup"));
            resetTransientState();
          }}
          className="vl-focus-ring text-zinc-300 underline-offset-4 hover:underline"
        >
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
        {mode === "login" && method === "email" ? (
          <Link href="/account/forgot-password" className="vl-focus-ring text-zinc-300 underline-offset-4 hover:underline">
            Forgot password?
          </Link>
        ) : null}
      </div>
    </form>
  );
}
