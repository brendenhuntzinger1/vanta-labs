"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { resolveSignupOutcome, SIGNUP_CHECK_EMAIL_MESSAGE } from "@/lib/auth-signup-outcome";
import { classifyAuthReturn, deadAuthLinkMessage, type AuthReturn } from "@/lib/auth-link-fragment";
import { safeInternalPath } from "@/lib/internal-path";
import {
  hasAnyOAuthProvider,
  isAppleSignInEnabled,
  isGoogleSignInEnabled,
} from "@/lib/oauth-providers";

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

// PORTAL IS THE FIRST SCREEN, AND THE ONLY ONE MOST VISITORS SEE.
//
// It asks the three questions the store has to ask and offers the two fastest
// ways in. The email forms are one tap behind it rather than in front of it:
// showing eight fields to someone who is going to press "Continue with Google"
// is the single biggest thing that made this card feel like paperwork.
type AuthMode = "portal" | "login" | "signup";

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
  // Same-origin only. "//evil.com" is protocol-relative and "/\evil.com"
  // resolves to the same place — safeInternalPath refuses both.
  const candidate = safeInternalPath(value, "");
  if (candidate) {
    const stranded = NEVER_A_SIGN_IN_DESTINATION.some(
      (p) => candidate === p || candidate.startsWith(`${p}/`) || candidate.startsWith(`${p}?`),
    );
    if (!stranded) {
      return candidate;
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
  // A referral link is an invitation to JOIN, so it opens the signup form
  // directly. A verification return has an account already and must not be
  // parked behind a gate. Everyone else starts at the portal.
  const [mode, setMode] = useState<AuthMode>(() => {
    // A referral link is an invitation to JOIN, so it opens the signup form.
    if (referralCodeFromUrl) return "signup";
    // ANYONE ARRIVING FROM AN EMAILED LINK SKIPS THE PORTAL.
    //
    // A confirmation or recovery return carries a message the sign-in form is
    // built to show — "your address is confirmed", "that link has expired",
    // "sign in to continue". Parking that person behind a gate asking them to
    // confirm their age would bury the one sentence they came back for, and
    // they have an account already, so the gate has nothing left to ask.
    //
    // Computed here rather than in an effect: both inputs are known at first
    // render, and deciding later would paint the portal and then replace it.
    if (typeof window !== "undefined") {
      const fromEmailLink = searchParams.get("verified") === "1" || Boolean(window.location.hash);
      if (fromEmailLink) return "login";
    }
    return "portal";
  });
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessType, setBusinessType] = useState<string>("Other");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [researchUseAgreed, setResearchUseAgreed] = useState(false);
  // Starts ticked, with the same "optional, unsubscribe anytime" wording the
  // checkout box uses. Before 2026-09-04 there was no box at all here, so no
  // account ever opted in and the welcome flow had never had a recipient.
  // UNCHECKED BY DEFAULT, AND THIS IS A DELIBERATE CHANGE.
  //
  // It used to arrive pre-ticked on the signup form. On the portal it sits
  // beside two boxes that are genuinely required to enter, and a pre-ticked
  // third box in that company reads as one more thing to get past rather than
  // a choice. Consent collected that way is worth very little: it produces a
  // list that opens badly and complains loudly, and it is the first thing an
  // inbox provider holds against a sending domain.
  //
  // Ticking it is what puts someone in marketing_subscribers. Not ticking it
  // costs them nothing — entry never depends on it, see canEnter below.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
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
  const [oauthPending, setOauthPending] = useState<"google" | "apple" | null>(null);
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
          marketingOptIn,
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

  // ---------------------------------------------------------------------
  // HANDING OFF TO A PROVIDER.
  //
  // The only thing this decides is where the visitor comes back to, and that
  // is built from window.location.origin plus a fixed path — never from
  // anything in the URL. `next` rides along as a query parameter so the
  // callback can return the visitor to the page that sent them here, and it is
  // re-validated there through safeInternalPath rather than trusted on the way
  // out. A redirect target that survives a round trip through two external
  // services is attacker-supplied by definition.
  //
  // No captcha here on purpose: the provider runs its own challenge, and the
  // token this flow returns is verified against GoTrue server-side before any
  // cookie is written.
  const startOAuth = async (provider: "google" | "apple") => {
    setError(null);
    setMessage(null);

    // THE SAME TWO REPRESENTATIONS EMAIL SIGNUP REQUIRES.
    //
    // /api/auth/signup writes age_confirmed_21 and research_use_only_agreed
    // into user_metadata, and it can only run once the form's two boxes are
    // ticked. A provider hands back an identity and nothing else, so without
    // this an account created through Google or Apple would carry neither —
    // and this store sells 21+ research-use-only material. The account-level
    // record is not optional just because the front door changed.
    //
    // Asked in BOTH modes, deliberately, because nothing here can tell a new
    // customer from a returning one until after the provider answers. Two taps
    // for a returning customer is the honest price of never creating an
    // unattested account.
    if (!ageConfirmed || !researchUseAgreed) {
      setError("Please confirm both statements above before continuing with Google or Apple.");
      return;
    }

    setOauthPending(provider);
    try {
      // Survives the round trip through two external services, and is read back
      // by the callback. sessionStorage rather than the redirect URL: this is a
      // record of what the visitor asserted, and a value the visitor could edit
      // in a query string would be worth nothing as evidence either way. Scoped
      // to the tab, cleared once used.
      try {
        window.sessionStorage.setItem("vl-oauth-attested", "true");
        // Recorded separately from the attestation because they are different
        // kinds of thing: one is a representation the visitor must make to
        // enter, the other is permission they may withhold and still enter.
        window.sessionStorage.setItem("vl-oauth-marketing", marketingOptIn ? "true" : "false");
      } catch {
        /* private mode: the callback simply will not claim an attestation */
      }
      const safeNext = safeInternalPath(nextPath, "/account");
      const redirectTo = `${window.location.origin}/account/auth/callback?next=${encodeURIComponent(safeNext)}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          // Ask for nothing beyond identity. The catalogue gate needs to know
          // WHO someone is, not to read their contacts or calendar, and a
          // consent screen listing scopes nobody uses costs conversions.
          scopes: provider === "google" ? "email profile" : undefined,
        },
      });
      if (oauthError) {
        throw new Error(oauthError.message);
      }
      // On success the browser is navigating away, so `oauthPending` stays set
      // deliberately — clearing it would flash the idle label mid-redirect.
    } catch (err) {
      setOauthPending(null);
      setError(
        err instanceof Error && err.message
          ? err.message
          : "We could not reach that sign-in provider. Please try again.",
      );
    }
  };

  // ---------------------------------------------------------------------
  // THE PORTAL. Two required representations, one optional permission, and the
  // two fastest doors.
  //
  // ENTRY DEPENDS ON THE FIRST TWO BOXES AND NEVER ON THE THIRD. That is not a
  // style choice: consent that is the price of admission is not consent, it is
  // a toll. It also poisons the list it fills — people who had no way to
  // decline are the ones who mark mail as spam, and that is charged against the
  // sending domain, not against the signup form. So the third box is genuinely
  // optional and genuinely off until someone turns it on.
  const canEnter = ageConfirmed && researchUseAgreed;

  if (mode === "portal") {
    return (
      <div className="vl-auth-card vl-fade-up mx-auto w-full max-w-[26rem] rounded-[22px] p-6 sm:p-8">
        <header className="text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-[color:var(--accent-gold)]">
            Vanta Labs
          </p>
          <h1 className="mt-3 text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.01em] text-white sm:text-[2rem]">
            Research Access Portal
          </h1>
          <p className="mt-3 text-[0.9375rem] leading-6 text-white/55">
            Access is limited to verified account holders.
          </p>
        </header>

        <p className="mt-7 text-center text-[0.8125rem] uppercase tracking-[0.16em] text-white/40">
          Please confirm the following to continue
        </p>

        {/* THE WHOLE ROW IS THE CONTROL.
            Each row is a <label> wrapping its input, so the tap target is the
            full width of the card rather than a 16px box. On a phone that is
            the difference between three confident taps and three near-misses,
            and it is why these are not bare checkboxes in a list. */}
        <div className="mt-4 space-y-2.5">
          <label className="vl-portal-row">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
              className="vl-auth-check mt-0.5"
            />
            <span>I confirm I am 21 years of age or older</span>
          </label>

          <label className="vl-portal-row">
            <input
              type="checkbox"
              checked={researchUseAgreed}
              onChange={(event) => setResearchUseAgreed(event.target.checked)}
              className="vl-auth-check mt-0.5"
            />
            <span>I understand products are offered exclusively for research use</span>
          </label>

          {/* Visually set apart from the two above, because it is a different
              kind of statement and the difference should be legible before it
              is read. The two above are conditions of entry; this one is a
              favour, and marking it optional in the label is the honest way to
              ask for it. */}
          <label className="vl-portal-row vl-portal-row-optional">
            <input
              type="checkbox"
              checked={marketingOptIn}
              onChange={(event) => setMarketingOptIn(event.target.checked)}
              className="vl-auth-check mt-0.5"
            />
            <span>
              I agree to receive Vanta Labs emails, product updates and offers
              <span className="ml-1.5 text-white/35">(optional)</span>
            </span>
          </label>
        </div>

        {error ? (
          <p role="alert" className="mt-5 rounded-[12px] border border-rose-400/25 bg-rose-500/[0.08] px-4 py-3 text-[0.875rem] leading-6 text-rose-200">{error}</p>
        ) : null}

        {hasAnyOAuthProvider() ? (
          <>
            <div className="mt-6 h-px bg-white/[0.08]" aria-hidden="true" />

            <div className="mt-6 space-y-3">
              {isGoogleSignInEnabled() ? (
                <button
                  type="button"
                  onClick={() => void startOAuth("google")}
                  disabled={oauthPending !== null || !canEnter}
                  className="vl-oauth-btn vl-oauth-btn-lg vl-focus-ring"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
                    <path fill="#4285F4" d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.96 3.44-8.55z" />
                    <path fill="#34A853" d="M12 23.5c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.02-6.45-4.74H1.7v2.98A11.5 11.5 0 0 0 12 23.5z" />
                    <path fill="#FBBC05" d="M5.55 14.18a6.9 6.9 0 0 1 0-4.36V6.84H1.7a11.5 11.5 0 0 0 0 10.32l3.85-2.98z" />
                    <path fill="#EA4335" d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.28 15.11.25 12 .25A11.5 11.5 0 0 0 1.7 6.84l3.85 2.98C6.46 7.1 9 4.75 12 4.75z" />
                  </svg>
                  <span>{oauthPending === "google" ? "Opening Google…" : "Continue with Google"}</span>
                </button>
              ) : null}

              {isAppleSignInEnabled() ? (
                <button
                  type="button"
                  onClick={() => void startOAuth("apple")}
                  disabled={oauthPending !== null || !canEnter}
                  className="vl-oauth-btn vl-oauth-btn-lg vl-focus-ring"
                >
                  <svg viewBox="0 0 24 24" className="h-[21px] w-[21px] shrink-0" aria-hidden="true" fill="currentColor">
                    <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.08 2.65-2.14.83-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.9 5.1c.6-.74 1.01-1.75.9-2.77-.87.04-1.94.59-2.57 1.31-.56.64-1.05 1.68-.92 2.67.98.08 1.98-.5 2.59-1.21z" />
                  </svg>
                  <span>{oauthPending === "apple" ? "Opening Apple…" : "Continue with Apple"}</span>
                </button>
              ) : null}
            </div>

            <div className="my-6 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-white/[0.06]" />
              <span className="text-[0.6875rem] uppercase tracking-[0.2em] text-white/30">or</span>
              <span className="h-px flex-1 bg-white/[0.06]" />
            </div>
          </>
        ) : (
          // No provider to offer: "Create an account" becomes the only door, so
          // it needs the breathing room the divider was providing.
          <div className="mt-7" />
        )}

        <button
          type="button"
          onClick={() => {
            if (!canEnter) {
              setError("Please confirm the first two statements to continue.");
              return;
            }
            setError(null);
            setMode("signup");
          }}
          disabled={!canEnter}
          className="vl-auth-submit vl-focus-ring w-full"
        >
          Create an account
        </button>

        {/* Sign in is a LINK, not a third button. A returning customer knows
            exactly what they are looking for, and giving it button weight would
            put three competing calls to action on a screen whose whole job is
            to make one choice obvious. It also stays available whatever the
            boxes say: someone who already has an account made these
            representations when they created it, and blocking them from their
            own orders over an unticked box would be absurd. */}
        <p className="mt-6 text-center text-[0.875rem] text-white/45">
          Already have an account?{" "}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("login");
            }}
            className="vl-focus-ring inline-flex min-h-6 items-center rounded-[6px] font-medium text-white/85 underline underline-offset-4 decoration-white/25 transition-colors duration-200 hover:text-white hover:decoration-white/60"
          >
            Sign in
          </button>
        </p>

        <p className="mt-6 text-center text-[0.75rem] leading-5 text-white/35">
          By continuing, you agree to our{" "}
          <Link href="/legal/terms" className="underline underline-offset-2 decoration-white/20 transition-colors hover:text-white/60">Terms</Link>
          {" "}and{" "}
          <Link href="/legal/privacy" className="underline underline-offset-2 decoration-white/20 transition-colors hover:text-white/60">Privacy Policy</Link>.
        </p>
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
          <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-[0.875rem] leading-6 text-white/75 transition-colors duration-200 hover:border-white/[0.12]">
            <input
              type="checkbox"
              checked={marketingOptIn}
              onChange={(event) => setMarketingOptIn(event.target.checked)}
              className="vl-auth-check mt-0.5"
              data-testid="signup-marketing-opt-in"
            />
            <span>Email me product news, restocks and offers. <span className="text-white/40">Optional — unsubscribe anytime.</span></span>
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

      {/* ------------------------------------------------------------------
          THREE FRONT DOORS, ONE SESSION.
          Google and Apple end at the same POST /api/auth/session that the form
          above does, so the cookie, its rotation and every authorisation check
          downstream are identical. A provider is a way of proving who you are,
          never a source of extra access.

          EMAIL STAYS. Requiring a Google or Apple account to shop would turn
          away buyers who have neither, for no security gain — all three prove
          the same thing to the same endpoint. It is a choice of door, not a
          tier of trust.

          Placed BELOW the primary action rather than above it. A returning
          customer's muscle memory is the email field; leading with provider
          buttons pushes the form they came for under the fold on a phone.
          ------------------------------------------------------------------ */}
      {/* THE WHOLE SECTION GOES, OR NONE OF IT DOES.

          The divider and the login-mode attestation boxes only exist to
          serve the provider buttons below them — the boxes are here purely
          because startOAuth refuses without them. Guarding just the buttons
          left an 'or continue with' rule pointing at nothing, above two
          checkboxes asking a returning customer to make representations for
          a control that is not on the page. */}
      {hasAnyOAuthProvider() ? (
        <div className="mt-7">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-white/[0.08]" />
            <span className="text-[0.6875rem] uppercase tracking-[0.2em] text-white/35">or continue with</span>
            <span className="h-px flex-1 bg-white/[0.08]" />
          </div>

          {/* IN LOGIN MODE THE TWO ATTESTATIONS LIVE HERE, BESIDE THE BUTTONS
              THAT REQUIRE THEM.
              Signup mode already renders them above the submit button, so
              repeating them there would ask the same question twice on one card.
              Login mode has no such block, and startOAuth refuses without them —
              so without this the visitor would be told to confirm two statements
              that are nowhere on screen, which is the worst kind of dead end. */}
          {mode === "login" ? (
            <div className="mt-5 space-y-2.5">
              <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[0.8125rem] leading-6 text-white/70 transition-colors duration-200 hover:border-white/[0.12]">
                <input
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(event) => setAgeConfirmed(event.target.checked)}
                  className="vl-auth-check mt-0.5"
                />
                <span>I confirm that I am at least 21 years old.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-[14px] border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[0.8125rem] leading-6 text-white/70 transition-colors duration-200 hover:border-white/[0.12]">
                <input
                  type="checkbox"
                  checked={researchUseAgreed}
                  onChange={(event) => setResearchUseAgreed(event.target.checked)}
                  className="vl-auth-check mt-0.5"
                />
                <span>These products are for laboratory research use only, not for human or animal consumption.</span>
              </label>
            </div>
          ) : null}

              {/* Two-up only when there are two. A lone button in a two-column
                  grid sits at half width against a full-width form above it,
                  which reads as a rendering fault rather than a choice. */}
              <div
                className={`mt-5 grid gap-3 ${
                  isGoogleSignInEnabled() && isAppleSignInEnabled() ? "sm:grid-cols-2" : "grid-cols-1"
                }`}
              >
                {isGoogleSignInEnabled() ? (
                  <button
                    type="button"
                    onClick={() => void startOAuth("google")}
                    disabled={oauthPending !== null || !ageConfirmed || !researchUseAgreed}
                    className="vl-oauth-btn vl-focus-ring"
                  >
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" aria-hidden="true">
                      <path fill="#4285F4" d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.63h6.2a5.3 5.3 0 0 1-2.3 3.48v2.89h3.72c2.18-2 3.44-4.960 3.44-8.55z" />
                      <path fill="#34A853" d="M12 23.5c3.11 0 5.72-1.03 7.62-2.79l-3.72-2.89c-1.03.69-2.35 1.1-3.9 1.1-3 0-5.54-2.02-6.45-4.74H1.7v2.98A11.5 11.5 0 0 0 12 23.5z" />
                      <path fill="#FBBC05" d="M5.55 14.18a6.9 6.9 0 0 1 0-4.36V6.84H1.7a11.5 11.5 0 0 0 0 10.32l3.85-2.98z" />
                      <path fill="#EA4335" d="M12 4.75c1.69 0 3.21.58 4.4 1.72l3.3-3.3C17.72 1.28 15.11.25 12 .25A11.5 11.5 0 0 0 1.7 6.84l3.85 2.98C6.46 7.1 9 4.75 12 4.75z" />
                    </svg>
                    <span>{oauthPending === "google" ? "Opening Google…" : "Continue with Google"}</span>
                  </button>
                ) : null}

                {isAppleSignInEnabled() ? (
                  <button
                    type="button"
                    onClick={() => void startOAuth("apple")}
                    disabled={oauthPending !== null || !ageConfirmed || !researchUseAgreed}
                    className="vl-oauth-btn vl-focus-ring"
                  >
                    <svg viewBox="0 0 24 24" className="h-[19px] w-[19px] shrink-0" aria-hidden="true" fill="currentColor">
                      <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.25 2.74 2.2 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.08 2.65-2.14.83-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.9 5.1c.6-.74 1.01-1.75.9-2.77-.87.04-1.94.59-2.57 1.31-.56.64-1.05 1.68-.92 2.67.98.08 1.98-.5 2.59-1.21z" />
                    </svg>
                    <span>{oauthPending === "apple" ? "Opening Apple…" : "Continue with Apple"}</span>
                  </button>
                ) : null}
              </div>

              {/* Names only the providers actually on offer. Telling someone what
                  "Google or Apple" does with their data, on a screen showing one
                  button, describes a choice they were never given. */}
              <p className="mt-4 text-[0.75rem] leading-5 text-white/40">
                Signing in with{" "}
                {isGoogleSignInEnabled() && isAppleSignInEnabled()
                  ? "Google or Apple"
                  : isGoogleSignInEnabled()
                    ? "Google"
                    : "Apple"}{" "}
                shares your name and email address with Vanta Labs. It does not subscribe you to
                marketing email.
              </p>

        </div>
      ) : null}

      <div className="mt-7 space-y-4 border-t border-white/[0.06] pt-6 text-center">
        {/* The way back out. Without it the email form is a one-way door: a
            visitor who opened "Create an account" and then decided to use
            Google has no route back to the buttons that offer it, short of
            reloading the page. */}
        <button
          type="button"
          onClick={() => {
            setMode("portal");
            resetTransientState();
          }}
          className="vl-focus-ring inline-flex min-h-6 items-center gap-1.5 rounded-[6px] text-[0.8125rem] text-white/40 transition-colors duration-200 hover:text-white/70"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M19 12H5M11 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All sign-in options
        </button>
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
