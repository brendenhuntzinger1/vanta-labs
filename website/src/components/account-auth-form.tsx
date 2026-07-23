"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type AuthMode = "login" | "signup";

// Business type shown on the account-creation screen, alongside the age +
// research-use confirmations. "Other" is the default selection.
const BUSINESS_TYPES = [
  "Other",
  "Healthcare / Medical",
  "Research / Academic",
  "Biotechnology",
  "Pharmaceutical",
  "Government / Military",
] as const;

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
  // After a normal sign-in (no explicit destination) send shoppers to the
  // home page rather than leaving them on the login screen.
  return "/";
}

export function AccountAuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCodeFromUrl = searchParams.get("ref") ?? "";
  const nextPath = safeNextPath(searchParams.get("next"));
  const [mode, setMode] = useState<AuthMode>(referralCodeFromUrl ? "signup" : "login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessType, setBusinessType] = useState<string>("Other");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [researchUseAgreed, setResearchUseAgreed] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
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
      // portals, but a role-less account is a customer and must finish signing
      // in (mirrors detectRoleFromUser's default-to-customer).
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
          body: JSON.stringify({ accessToken, rememberMe: true }),
        });
        const sessionJson = await sessionResponse.json();
        if (!sessionResponse.ok || !sessionJson.success) {
          throw new Error(sessionJson.error ?? "Unable to establish session");
        }

        router.replace(nextPath);
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
      body: JSON.stringify({ accessToken, rememberMe }),
    });
    const sessionJson = await sessionResponse.json();
    if (!sessionResponse.ok || !sessionJson.success) {
      throw new Error(sessionJson.error ?? "Unable to establish session");
    }
    // replace() so the login page isn't left in history (back button won't
    // bounce the now-signed-in user back onto the form).
    router.replace(nextPath);
    router.refresh();
  };

  const handleSignup = async () => {
    if (!ageConfirmed) {
      setError("Please confirm that you are at least 21 years old.");
      return;
    }
    if (!researchUseAgreed) {
      setError("Please agree that the products are intended for research use only.");
      return;
    }

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
            business_type: businessType,
            age_confirmed_21: true,
            research_use_only_agreed: true,
            referred_by_code: referralCodeFromUrl || undefined,
          },
          emailRedirectTo: getEmailRedirectUrl(`/account/login?next=${encodeURIComponent(nextPath)}`),
        },
      });

      if (signUpError || !data.user) {
        throw new Error(signUpError?.message ?? "Unable to create account");
      }

      // Supabase's anti-enumeration behavior returns an obfuscated user with an
      // empty identities array (and sends NO email) when the address is already
      // registered. Detect that and point them to sign in instead of telling
      // them to check for an email that will never arrive.
      if (Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        setMode("login");
        setMessage("That email is already registered. Please sign in below.");
        return;
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

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    void (mode === "signup" ? handleSignup() : handleLogin());
  };

  const resetTransientState = () => {
    setError(null);
    setMessage(null);
  };

  if (completingVerification) {
    return (
      <div className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 text-center sm:p-8">
        <p className="text-sm text-zinc-300">Confirming your account…</p>
      </div>
    );
  }

  const primaryLabel = mode === "signup" ? "Create Account" : "Sign In";

  return (
    <form onSubmit={handleSubmit} className="vl-panel mx-auto w-full max-w-md rounded-[1.75rem] p-6 sm:p-8">
      <p className="text-[11px] uppercase tracking-[0.35em] text-zinc-300">My Account</p>
      <h1 className="mt-3 text-3xl font-semibold text-white">{mode === "signup" ? "Create your account" : "Sign In"}</h1>
      <p className="mt-2 text-sm text-zinc-400">
        {mode === "signup"
          ? "Track orders, save addresses, and check out faster."
          : "Access your order history, saved addresses, and wishlist."}
      </p>

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

        {mode === "signup" ? (
          <label className="block text-sm text-zinc-400">
            <span className="mb-2 block">Business Type</span>
            <select
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value)}
              className="vl-input w-full px-4 py-3"
              required
            >
              {BUSINESS_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {mode === "signup" ? (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-3 rounded-xl border border-emerald-300/30 bg-emerald-400/[0.06] px-4 py-3 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500"
            />
            <span>I confirm that I am at least 21 years old.</span>
          </label>
          <label className="flex items-start gap-3 rounded-xl border border-emerald-300/30 bg-emerald-400/[0.06] px-4 py-3 text-sm text-zinc-200">
            <input
              type="checkbox"
              checked={researchUseAgreed}
              onChange={(event) => setResearchUseAgreed(event.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-500"
            />
            <span>I agree and understand that the products on this site are intended for research use only, as defined by FDA.</span>
          </label>
        </div>
      ) : null}

      <label className="mt-4 flex min-h-[44px] cursor-pointer items-center gap-3 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(event) => setRememberMe(event.target.checked)}
          className="h-5 w-5 shrink-0 accent-emerald-500"
        />
        Keep me signed in on this device
      </label>

      {message ? <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{message}</p> : null}
      {error ? <p className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

      <button
        type="submit"
        disabled={loading || (mode === "signup" && (!ageConfirmed || !researchUseAgreed))}
        className="vl-focus-ring mt-6 inline-flex w-full items-center justify-center rounded-full bg-emerald-500 px-6 py-3 text-sm font-bold text-[#04120c] shadow-[0_8px_24px_-8px_rgba(16,185,129,0.6)] transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
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
        {mode === "login" ? (
          <Link href="/account/forgot-password" className="vl-focus-ring text-zinc-300 underline-offset-4 hover:underline">
            Forgot password?
          </Link>
        ) : null}
      </div>
    </form>
  );
}
