"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function getAgeVerifiedSnapshot() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.localStorage.getItem("vanta-labs-age-verified") === "true") {
      return true;
    }
  } catch (error) {
    console.error("Unable to read age verification state", error);
  }

  // Fall back to the cookie mirror when localStorage is unavailable/blocked.
  try {
    return document.cookie.split("; ").some((c) => c === "vl_age_verified=true");
  } catch {
    return false;
  }
}

function subscribeToAgeVerified(callback: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === "vanta-labs-age-verified") {
      callback();
    }
  };

  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("storage", handleStorage);
  };
}

export function AgeGate({ children }: { children: React.ReactNode }) {
  const [localVerified, setLocalVerified] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const isVerifiedFromStorage = useSyncExternalStore(
    subscribeToAgeVerified,
    getAgeVerifiedSnapshot,
    () => false,
  );
  const isVerified = isVerifiedFromStorage || localVerified;

  const markVerified = () => {
    try {
      window.localStorage.setItem("vanta-labs-age-verified", "true");
      // A cookie mirrors the flag so verification survives localStorage being
      // unavailable (private mode, some in-app browsers) and is consistent
      // across tabs. 30-day attestation window.
      document.cookie = "vl_age_verified=true; path=/; max-age=" + 60 * 60 * 24 * 30 + "; samesite=lax";
    } catch (error) {
      console.error("Unable to save age verification state", error);
    }
    setLocalVerified(true);
  };

  const handleEnter = () => {
    if (!agreed) {
      setShowPrompt(true);
      return;
    }
    markVerified();
  };

  // Confirm age first (same gate), then send the visitor to the account
  // sign-up / sign-in page instead of straight into the storefront.
  const handleAccount = () => {
    if (!agreed) {
      setShowPrompt(true);
      return;
    }
    markVerified();
    window.location.assign("/account/login");
  };

  const handleExit = () => {
    setLocalVerified(false);
    try {
      window.localStorage.removeItem("vanta-labs-age-verified");
      document.cookie = "vl_age_verified=; path=/; max-age=0; samesite=lax";
    } catch (error) {
      console.error("Unable to clear age verification state", error);
    }
    window.location.assign("https://www.google.com");
  };

  // Move focus into the blocking gate when it appears so keyboard/screen-reader
  // users land on it instead of the (inert) page behind it.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isVerified) return;
    dialogRef.current?.focus();
    // Lock body scroll so the (now server-rendered) content behind the overlay
    // can't be scrolled or interacted with until the visitor confirms.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isVerified]);

  // Always render the store content so search engines receive the real
  // server-side HTML (the gate previously REPLACED all content, making every
  // page look like the same "Are you 21?" panel to crawlers). For human
  // visitors the gate is a fixed full-screen overlay on top of that content
  // until they confirm; body scroll is locked so they can't interact behind it.
  return (
    <>
      {children}
      {!isVerified ? (
      <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-[#060606] px-4 py-8 text-zinc-100 sm:items-center sm:px-6 sm:py-10">
        {/* Layered ambient light — warm gold + cool blue, matching the brand */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_28%_18%,_rgba(242,201,76,0.12),_transparent_52%),radial-gradient(ellipse_at_82%_85%,_rgba(140,180,255,0.09),_transparent_50%),linear-gradient(160deg,_#050505_0%,_#0c0c0c_48%,_#050505_100%)]" />
        {/* Faint grid texture for depth */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.5] [background-image:linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]" />

        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="age-gate-title"
          tabIndex={-1}
          className="vl2-fade-in vl-focus-ring relative w-full max-w-lg rounded-[1.75rem] border border-white/10 bg-[rgba(12,12,12,0.72)] p-6 text-center shadow-[0_28px_80px_rgba(0,0,0,0.6)] backdrop-blur-2xl sm:rounded-[2rem] sm:p-9"
        >
          {/* Monogram */}
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--accent-gold)]/25 bg-gradient-to-br from-[color:var(--accent-gold)]/[0.12] to-white/[0.02] shadow-[0_0_28px_rgba(242,201,76,0.14)]">
            <span className="vl2-serif text-xl tracking-[0.12em] text-white">VL</span>
          </div>

          <p className="vl2-eyebrow mt-6 flex items-center justify-center gap-2 text-[color:var(--accent-gold)]/70">
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
            Restricted Access · 21+
            <span className="h-px w-6 bg-[color:var(--accent-gold)]/30" />
          </p>

          <h1 id="age-gate-title" className="vl2-serif mt-4 text-4xl text-white sm:text-5xl">Vanta Labs</h1>
          <p className="mt-3 text-sm text-white/55 sm:text-base">Research Integrity. Verified Quality.</p>

          {/* Trust chips */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {["Batch Tested", "COA Documented", "Encrypted Checkout"].map((point) => (
              <span key={point} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[0.62rem] font-medium uppercase tracking-[0.14em] text-white/55">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3 text-emerald-300/80" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>
                {point}
              </span>
            ))}
          </div>

          <div className="my-7 h-px w-full bg-gradient-to-r from-transparent via-white/12 to-transparent" />

          <p className="text-lg font-medium text-white sm:text-xl">Are you 21 years of age or older?</p>

          <label className="group mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-left text-sm text-white/70 transition-colors duration-200 hover:border-white/20 has-[:checked]:border-emerald-400/30 has-[:checked]:bg-emerald-400/[0.04]">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => {
                setAgreed(event.target.checked);
                if (showPrompt) {
                  setShowPrompt(false);
                }
              }}
              className="mt-0.5 h-5 w-5 shrink-0 rounded accent-emerald-400"
            />
            <span>I confirm that I am at least 21 years of age and understand that Vanta Labs products are intended only for lawful laboratory research purposes.</span>
          </label>

          {showPrompt ? <p role="alert" className="mt-3 text-sm text-[color:var(--accent-gold)]">Please confirm your age before continuing.</p> : null}

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handleAccount}
              disabled={!agreed}
              className="vl2-btn-primary vl-focus-ring px-6 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create account / Sign in
            </button>
            <button
              type="button"
              onClick={handleEnter}
              disabled={!agreed}
              className="vl2-btn-secondary vl-focus-ring px-6 py-3.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue as guest
            </button>
          </div>

          <p className="mx-auto mt-5 max-w-sm text-xs leading-6 text-white/45">
            Create a free account to track orders, save your cart, and earn rewards — or continue as a guest and check out with just your email.
          </p>

          <button
            type="button"
            onClick={handleExit}
            className="vl-focus-ring mt-5 text-xs text-white/40 underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            I am under 21 — exit
          </button>

          <p className="mt-6 border-t border-white/[0.07] pt-5 text-[0.62rem] uppercase tracking-[0.2em] text-white/30">
            Research Use Only · © Vanta Labs
          </p>
        </div>
      </div>
      ) : null}
    </>
  );
}
