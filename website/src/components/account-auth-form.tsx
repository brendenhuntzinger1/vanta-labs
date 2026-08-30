"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { resolveSignupOutcome, SIGNUP_CHECK_EMAIL_MESSAGE } from "@/lib/auth-signup-outcome";
import { classifyAuthReturn, deadAuthLinkMessage, type AuthReturn } from "@/lib/auth-link-fragment";

// When a Turnstile site key is configured, every auth call carries a CAPTCHA
// token that Supabase verifies — blocking bots from draining email + SMS spend.
// Absent the key, the whole layer is a graceful no-op.
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";

// Seconds a shopper must wait between "Text me a code" requests. A cheap client
// speed-bump on top of Supabase/Twilio limits so a single visitor can't fire off
// paid SMS in a rapid loop.
const OTP_RESEND_COOLDOWN_SECONDS = 45;

// Phone/SMS sign-in stays hidden until the Twilio Trust Hub compliance profile
// is approved — otherwise the "Text me a code" button returns a Twilio error to
// real shoppers. Flip to true once Twilio approves the account, then redeploy.
const PHONE_LOGIN_ENABLED = false;

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

// A legal page is somewhere you READ, never somewhere you are sent. Landing
// there after signing in was reported from a phone: a policy link tapped at the
// age gate became the destination that followed the visitor through auth.
const NEVER_A_SIGN_IN_DESTINATION = ["/legal", "/account/login"];

function safeNextPath(value: string | null): string {
  // Same-origin only — "//evil.com" is a protocol-relative URL, not a path.
  if (value && value.startsWith("/") && !value.startsWith("//")) {
    const stranded = NEVER_A_SIGN_IN_DESTINATION.some(
      (p) => value === p || value.startsWith(`${p}/`) || value.startsWith(`${p}?`),
    );
    if (!stranded) {
      return value;
    }
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
  // Purely presentational: toggles the password field between text and
  // password. Never touches what is submitted.
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [completingVerification, setCompletingVerification] = useState(false);
  // WHETHER THIS PAGE LOAD REALLY IS A RETURN FROM AN EMAILED LINK.
  //
  // Classified ONCE, at first render, before supabase-js can consume the
  // fragment (the browser client is lazily constructed on first `supabase.auth`
  // access, which happens later, inside the effect below).
  //
  // `?verified=1` used to be enough on its own. It is not evidence: it is
  // typed, shared, bookmarked and re-opened, and on any of those loads
  // getSession() falls back to whatever supabase-js kept in localStorage — so
  // the page signed the visitor in as whoever last used the browser. Only a
  // fragment that actually carries a token counts. See lib/auth-link-fragment.
  const [authReturn] = useState<AuthReturn>(() => {
    if (typeof window === "undefined") return { kind: "none" };
    return classifyAuthReturn(window.location.hash);
  });
  const [arrivedFromEmailLink] = useState(() => {
    if (typeof window === "undefined") return false;
    return searchParams.get("verified") === "1" || Boolean(window.location.hash);
  });
  const isVerificationReturn = authReturn.kind === "session";

  // WHAT HAPPENS WHEN THE LINK IS DEAD.
  //
  // Three ways a confirmation link fails, and until now all three landed the
  // customer on an ordinary, unannotated sign-in form:
  //
  //   * GoTrue redirected with `#error=access_denied&error_code=otp_expired`
  //     — a spent or expired token. Mailbox security scanners pre-fetch links
  //     and burn them before the human clicks, which is exactly what happened
  //     to the applicant of 2026-08-28 ("One-time token not found").
  //   * /auth/confirm could not forward at all and sent `?link=invalid`.
  //   * `?verified=1` arrived with no fragment — a re-opened, shared or typed
  //     URL. The address IS confirmed by then (GoTrue verified before
  //     redirecting), so this is not an error; they just need to sign in. What
  //     it must never do is promote a leftover localStorage session.
  //
  // Seeded as INITIAL STATE rather than set from an effect: all three inputs
  // are known at first render, so an effect would only paint the bare form and
  // then re-render — a cascading render, and a visible flash of the very
  // "nothing happened" page this exists to replace.
  const [message, setMessage] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    if (authReturn.kind !== "none" || !arrivedFromEmailLink) return null;
    return searchParams.get("verified") === "1"
      ? "Your email address is confirmed. Sign in below to finish setting up your account."
      : null;
  });
  const [error, setError] = useState<string | null>(() => {
    if (authReturn.kind === "error") return deadAuthLinkMessage(authReturn.errorCode);
    const linkProblem = searchParams.get("link");
    if (!linkProblem) return null;
    return linkProblem === "unavailable"
      ? "We couldn't check that link just now. Enter your email below and we'll send you a new one."
      : deadAuthLinkMessage();
  });
  // Sign in with a texted one-time code as an alternative to email + password.
  const [loginMethod, setLoginMethod] = useState<"email" | "phone">("email");
  const [phone, setPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  // Single-use Turnstile token + a bump counter to reset the widget after each try.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);


  // A shopper who clicked the confirmation link in Supabase's built-in
  // verification email lands back here with a session already established
  // by the Supabase client (it reads the token from the URL fragment) -
  // finish signing them in by setting our own httpOnly session cookie.
  //
  // Gated to verification returns ONLY. The Supabase client also keeps a
  // long-lived copy of past sessions in localStorage, and running this on
  // every visit made the login page silently re-establish that session and
  // bounce straight to the home page — the shopper never saw the form.
  useEffect(() => {
    if (!isVerificationReturn) {
      return;
    }

    let active = true;

    (async () => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      const refreshToken = data.session?.refresh_token ?? null;
      const user = data.session?.user;

      if (!accessToken || !user) {
        return;
      }

      // Complete the session for any shopper. Admins have a separate portal and
      // a separate session token, so they are skipped.
      //
      // AMBASSADORS ARE NOT. They used to be skipped here too, which left an
      // invited ambassador confirmed but with no session — on a login page that
      // would not forward them, to a dashboard that would not admit them. Their
      // portal is a tab inside the customer dashboard; see auth-role.ts.
      const role = String(user.app_metadata?.role ?? user.user_metadata?.role ?? "").toLowerCase();
      if (role === "admin") {
        return;
      }

      if (active) {
        setCompletingVerification(true);
      }

      try {
        const sessionResponse = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken, refreshToken, rememberMe: true }),
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
  }, [router, nextPath, isVerificationReturn]);

  // Tick down the "Text me a code" cooldown once per second.
  useEffect(() => {
    if (otpCooldown <= 0) return;
    const timer = setInterval(() => {
      setOtpCooldown((seconds) => (seconds <= 1 ? 0 : seconds - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpCooldown]);

  // A CAPTCHA token is single-use — after each auth attempt, force the widget to
  // mint a fresh one so the next attempt isn't rejected for a spent token.
  const resetCaptcha = () => {
    if (!TURNSTILE_SITE_KEY) return;
    setCaptchaToken(null);
    setCaptchaResetKey((key) => key + 1);
  };

  const establishSessionAndGo = async (accessToken: string, refreshToken: string | null = null) => {
    const sessionResponse = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, refreshToken, rememberMe }),
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
      // THROUGH THE SERVER, SO THE CONFIRMATION EMAIL IS OURS.
      //
      // A browser-side signUp() makes Supabase Auth mail the confirmation
      // itself, from its own unstyled template, invisible to the bounce
      // webhook and the send log. That is what stranded four signups on
      // 2026-08-29 — Resend said "delivered" for every one of them and Gmail
      // had filed them as phishing. /api/auth/signup mints the link with the
      // admin API and sends it branded through sendEmail() instead.
      //
      // The route answers identically for a new and an existing address, so it
      // cannot be used to probe which addresses have accounts; see its header.
      const signupResponse = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          fullName: fullName.trim(),
          businessType,
          referredByCode: referralCodeFromUrl || "",
          captchaToken: captchaToken ?? "",
          nextPath,
        }),
      });
      const signupJson = await signupResponse.json().catch(() => null);

      if (signupResponse.ok && signupJson?.success) {
        setMessage(signupJson.message ?? SIGNUP_CHECK_EMAIL_MESSAGE);
        return;
      }
      // A refusal the customer can act on (weak password, captcha, rate limit)
      // is theirs to see. Anything else falls through to the client path below.
      if (signupJson && signupJson.success === false && typeof signupJson.error === "string") {
        throw new Error(signupJson.error);
      }

      // FALLBACK, and the reason this change is strictly additive: if the route
      // is unreachable or answers with something unexpected, do exactly what
      // this form did before it existed. At worst signup behaves as it always
      // has; at best the customer gets a branded email we can see.
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
          emailRedirectTo: getEmailRedirectUrl(`/account/login?verified=1&next=${encodeURIComponent(nextPath)}`),
          captchaToken: captchaToken ?? undefined,
        },
      });

      if (signUpError) {
        throw new Error(signUpError.message);
      }

      // SECURITY: Supabase returns an obfuscated user with an empty identities
      // array — and sends NO email — when the address already exists, so signup
      // can't be used to enumerate accounts. resolveSignupOutcome preserves that
      // by returning the identical outcome either way.
      //
      // What it deliberately does NOT do is claim a link was sent. For a
      // returning user none is, and the old copy ("we've sent a secure link")
      // left them waiting on an inbox that would never receive anything — with
      // the reset link hidden, because it used to render only in login mode.
      // See auth-signup-outcome.ts.
      const outcome = resolveSignupOutcome(data);
      if (outcome.kind === "failed") {
        throw new Error("Unable to create account");
      }
      if (outcome.kind === "check-email") {
        setMessage(outcome.message);
        return;
      }

      await establishSessionAndGo(outcome.accessToken, outcome.refreshToken);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to create account");
    } finally {
      setLoading(false);
      resetCaptcha();
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
        options: { captchaToken: captchaToken ?? undefined },
      });

      if (signInError || !data.session?.access_token) {
        throw new Error(signInError?.message ?? "Unable to sign in");
      }

      await establishSessionAndGo(data.session.access_token, data.session.refresh_token ?? null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to sign in");
    } finally {
      setLoading(false);
      resetCaptcha();
    }
  };

  // An account that never got confirmed had no way back. Its verification link
  // is one-time, and mailbox security scanners routinely fetch every link in a
  // message before the human does — which burns the token and leaves the real
  // click with "Email link is invalid or has expired". The auth log shows
  // exactly that ("One-time token not found") for an applicant who signed up on
  // 2026-08-28 and is still unconfirmed.
  //
  // Re-submitting the signup form was the only workaround, and it is both
  // rate-limited (429 over_email_send_rate_limit) and not labelled as a resend,
  // so nobody found it. resend() is the supported path and is enumeration-safe:
  // it reports the same success whether or not a pending signup exists.
  const handleResendConfirmation = async () => {
    const address = email.trim();
    if (!address) {
      setError("Enter your email address first, then choose “Resend confirmation email”.");
      return;
    }

    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      // THROUGH THE SERVER, for the same reason signup is.
      //
      // This used to call the Supabase client's resend(), which mails their own
      // template — the exact message Gmail filed as spam on 2026-08-29, links
      // stripped on the way in. Re-sending someone an identical copy of the
      // email they already could not use is not a recovery path. The route
      // mints a magic link and sends it branded instead.
      const resendResponse = await fetch("/api/auth/resend-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address, captchaToken: captchaToken ?? "", nextPath }),
      });
      const resendJson = await resendResponse.json().catch(() => null);

      if (!resendResponse.ok && resendJson && typeof resendJson.error === "string") {
        throw new Error(resendJson.error);
      }

      setMessage(resendJson?.message ?? "If that address has an account still waiting on confirmation, a new link is on its way. It can take a minute — check spam too.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to resend the confirmation email");
    } finally {
      setLoading(false);
      resetCaptcha();
    }
  };

  // Keep only digits with a single leading "+" (Supabase expects E.164 phone).
  const normalizePhone = (raw: string) => `+${raw.replace(/[^\d]/g, "")}`;

  const handleSendOtp = async () => {
    if (otpCooldown > 0) {
      setError(`Please wait ${otpCooldown}s before requesting another code.`);
      return;
    }
    const normalized = normalizePhone(phone);
    if (normalized.length < 9) {
      setError("Enter your phone in full international format, e.g. +1 813 555 0000.");
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        phone: normalized,
        options: { captchaToken: captchaToken ?? undefined },
      });
      if (otpError) throw new Error(otpError.message);
      setOtpSent(true);
      setOtpCooldown(OTP_RESEND_COOLDOWN_SECONDS);
      setMessage("We texted you a 6-digit code. Enter it below to sign in.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Couldn't send the code. Try again.");
    } finally {
      setLoading(false);
      resetCaptcha();
    }
  };

  const handleVerifyOtp = async () => {
    const normalized = normalizePhone(phone);
    const token = otpCode.trim();
    if (token.length < 4) {
      setError("Enter the code we texted you.");
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const { data, error: verifyError } = await supabase.auth.verifyOtp({ phone: normalized, token, type: "sms" });
      if (verifyError || !data.session?.access_token) {
        throw new Error(verifyError?.message ?? "That code didn't work. Request a new one.");
      }
      await establishSessionAndGo(data.session.access_token, data.session.refresh_token ?? null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Couldn't verify the code.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (loading) return;
    if (mode === "signup") {
      void handleSignup();
      return;
    }
    if (loginMethod === "phone") {
      void (otpSent ? handleVerifyOtp() : handleSendOtp());
      return;
    }
    void handleLogin();
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

  const isSendCodeAction = mode === "login" && loginMethod === "phone" && !otpSent;
  const sendBlockedByCooldown = isSendCodeAction && otpCooldown > 0;

  const primaryLabel = mode === "signup"
    ? "Create Account"
    : loginMethod === "phone"
      ? otpSent
        ? "Verify & Sign In"
        : sendBlockedByCooldown
          ? `Resend in ${otpCooldown}s`
          : "Text me a code"
      : "Sign In";

  return (
    <form
      onSubmit={handleSubmit}
      className="vl-auth-card vl-fade-up mx-auto w-full max-w-[26rem] rounded-[22px] p-6 sm:p-8"
    >
      <header>
        <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[color:var(--accent-gold)]">
          {mode === "signup" ? "Join Vanta Labs" : "Welcome back"}
        </p>
        <h1 className="mt-3 text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.01em] text-white sm:text-[2rem]">
          {mode === "signup" ? "Create your account" : "Sign in to Vanta Labs"}
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-6 text-white/55">
          {mode === "signup"
            ? "Track orders, save addresses, and check out faster."
            : "Access your orders, membership, rewards, saved addresses, and account details."}
        </p>
      </header>

      <div className="mt-7 space-y-4">
        {mode === "signup" ? (
          <label className="block">
            <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Full name</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="vl-auth-field w-full px-4"
              autoComplete="name"
              required
            />
          </label>
        ) : null}

        {PHONE_LOGIN_ENABLED && mode === "login" ? (
          <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-white/10 bg-black/40 p-1">
            <button
              type="button"
              onClick={() => { setLoginMethod("email"); setOtpSent(false); resetTransientState(); }}
              className={`rounded-[11px] px-3 py-2.5 text-[0.8125rem] font-medium transition-colors duration-200 ${loginMethod === "email" ? "bg-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]" : "text-white/45 hover:text-white/75"}`}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => { setLoginMethod("phone"); resetTransientState(); }}
              className={`rounded-[11px] px-3 py-2.5 text-[0.8125rem] font-medium transition-colors duration-200 ${loginMethod === "phone" ? "bg-white/[0.10] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]" : "text-white/45 hover:text-white/75"}`}
            >
              Phone
            </button>
          </div>
        ) : null}

        {(mode === "signup" || loginMethod === "email") ? (
          <>
            <label className="block">
              <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Email</span>
              <span className="relative block">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/35">
                  <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
                  <path d="m3 6.5 9 6 9-6" />
                </svg>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="vl-auth-field w-full pl-11 pr-4"
                  autoComplete="email"
                  required
                />
              </span>
            </label>

            <label className="block">
              <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Password</span>
              <span className="relative block">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/35">
                  <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
                  <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                </svg>
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="vl-auth-field w-full pl-11 pr-12"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="vl-focus-ring absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-[10px] text-white/40 transition-colors duration-200 hover:text-white/80"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
                    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                    <circle cx="12" cy="12" r="3" />
                    {showPassword ? <path d="m4 20 16-16" /> : null}
                  </svg>
                </button>
              </span>
            </label>
          </>
        ) : null}

        {mode === "login" && loginMethod === "phone" ? (
          <>
            <label className="block">
              <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Phone number</span>
              <input
                type="tel"
                value={phone}
                onChange={(event) => { setPhone(event.target.value); setOtpSent(false); }}
                placeholder="+1 813 555 0000"
                className="vl-auth-field w-full px-4"
                autoComplete="tel"
                required
              />
            </label>
            {otpSent ? (
              <label className="block">
                <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Text-message code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={otpCode}
                  onChange={(event) => setOtpCode(event.target.value)}
                  placeholder="6-digit code"
                  className="vl-auth-field w-full px-4 tracking-[0.4em]"
                  autoComplete="one-time-code"
                  required
                />
              </label>
            ) : (
              <p className="text-[0.8125rem] leading-5 text-white/45">No password needed — we&apos;ll text you a 6-digit code to sign in.</p>
            )}
          </>
        ) : null}

        {mode === "signup" ? (
          <label className="block">
            <span className="mb-2 block text-[0.8125rem] font-medium text-white/70">Business type</span>
            <select
              value={businessType}
              onChange={(event) => setBusinessType(event.target.value)}
              className="vl-auth-field w-full px-4"
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
        <div className="mt-5 space-y-2.5">
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-[0.875rem] leading-6 text-white/75 transition-colors duration-200 hover:border-white/[0.12]">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
              className="vl-auth-check mt-0.5"
            />
            <span>I confirm that I am at least 21 years old.</span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-[0.875rem] leading-6 text-white/75 transition-colors duration-200 hover:border-white/[0.12]">
            <input
              type="checkbox"
              checked={researchUseAgreed}
              onChange={(event) => setResearchUseAgreed(event.target.checked)}
              className="vl-auth-check mt-0.5"
            />
            <span>I agree and understand that the products on this site are intended strictly for laboratory research use only, and not for human or animal consumption.</span>
          </label>
        </div>
      ) : null}

      <label className="mt-5 flex min-h-[44px] cursor-pointer select-none items-center gap-3 text-[0.875rem] text-white/70 transition-colors duration-200 hover:text-white/90">
        <input
          type="checkbox"
          checked={rememberMe}
          onChange={(event) => setRememberMe(event.target.checked)}
          className="vl-auth-check"
        />
        Keep me signed in on this device
      </label>

      {TURNSTILE_SITE_KEY ? (
        <TurnstileWidget
          siteKey={TURNSTILE_SITE_KEY}
          onToken={setCaptchaToken}
          resetKey={captchaResetKey}
        />
      ) : null}

      {message ? (
        <p role="status" className="mt-5 rounded-[12px] border border-[color:var(--accent-gold)]/25 bg-[var(--accent-gold-soft)] px-4 py-3 text-[0.875rem] leading-6 text-[color:var(--accent-gold-strong)]">{message}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-5 rounded-[12px] border border-rose-400/25 bg-rose-500/[0.08] px-4 py-3 text-[0.875rem] leading-6 text-rose-200">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={loading || sendBlockedByCooldown || (mode === "signup" && (!ageConfirmed || !researchUseAgreed))}
        className="vl-auth-submit vl-focus-ring mt-6 w-full"
      >
        {loading ? "Please wait…" : primaryLabel}
      </button>

      <div className="mt-7 space-y-4 border-t border-white/[0.06] pt-6 text-center">
        <p className="text-[0.875rem] text-white/45">
          {mode === "signup" ? "Already have an account?" : "New to Vanta Labs?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode((current) => (current === "signup" ? "login" : "signup"));
              resetTransientState();
            }}
            /* min-h-6 keeps this signup/sign-in toggle at a 24px tap target.
               It reads as inline text, but it is the entry point to creating an
               account and was 21px tall. inline-flex holds it in the sentence. */
            className="vl-focus-ring inline-flex min-h-6 items-center rounded-[6px] font-medium text-white/85 underline underline-offset-4 decoration-white/25 transition-colors duration-200 hover:text-white hover:decoration-white/60"
          >
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </p>
        {/* Shown in SIGNUP mode too, deliberately.
            A returning user who has forgotten their password reliably ends up
            on the signup tab — the partner landing sends them to "Sign in /
            Create account", and creating an account is what they think the
            affiliate flow asks for. Supabase answers that with silence (no
            email, by design), so the recovery link is the only way out, and it
            used to be the one thing hidden on that tab. These are static links
            rendered for everyone, so nothing here reveals whether an account
            exists. */}
        {mode === "signup" || loginMethod === "email" ? (
          <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <Link
              href="/account/forgot-password"
              className="vl-focus-ring inline-flex min-h-[36px] items-center rounded-[6px] px-1 text-[0.875rem] text-white/45 underline-offset-4 transition-colors duration-200 hover:text-white/80 hover:underline"
            >
              Forgot your password?
            </Link>
            <button
              type="button"
              onClick={handleResendConfirmation}
              disabled={loading}
              className="vl-focus-ring inline-flex min-h-[36px] items-center rounded-[6px] px-1 text-[0.875rem] text-white/45 underline-offset-4 transition-colors duration-200 hover:text-white/80 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              Resend confirmation email
            </button>
          </p>
        ) : null}
      </div>
    </form>
  );
}
