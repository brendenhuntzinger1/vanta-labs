"use client";

import { useState, useSyncExternalStore } from "react";

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

  if (!isVerified) {
    return (
      <div className="flex min-h-screen items-start justify-center overflow-y-auto bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.16),_transparent_55%),linear-gradient(135deg,_#020202_0%,_#111111_50%,_#050505_100%)] px-4 py-8 text-zinc-100 sm:items-center sm:px-6 sm:py-10">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,_rgba(242,201,76,0.10),_transparent_55%),radial-gradient(ellipse_at_80%_80%,_rgba(140,180,255,0.08),_transparent_50%)] opacity-70" />
        <div className="vl-panel relative w-full max-w-2xl rounded-[1.75rem] p-5 text-center sm:rounded-[2rem] sm:p-8 xl:p-10">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-white/20 bg-white/10 text-2xl font-semibold tracking-[0.3em] text-white">
            VL
          </div>
          <p className="mb-4 text-[11px] uppercase tracking-[0.35em] text-zinc-400 sm:text-xs sm:tracking-[0.45em]">Restricted Access</p>
          <h1 className="text-3xl font-semibold tracking-[0.2em] text-white sm:text-5xl sm:tracking-[0.3em]">Vanta Labs</h1>
          <p className="mt-4 text-base text-zinc-300 sm:text-lg">Research Integrity. Verified Quality.</p>
          <p className="mt-7 text-lg font-medium text-white sm:mt-8 sm:text-xl">Are you 21 years of age or older?</p>
          <label className="vl-panel-soft mt-6 flex items-start justify-center gap-3 rounded-[1.25rem] p-4 text-left text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(event) => {
                setAgreed(event.target.checked);
                if (showPrompt) {
                  setShowPrompt(false);
                }
              }}
              className="mt-1 h-4 w-4 rounded border-zinc-700 bg-zinc-900"
            />
            <span>I confirm that I am at least 21 years of age and understand that Vanta Labs products are intended only for lawful laboratory research purposes.</span>
          </label>
          {showPrompt ? <p className="mt-4 text-sm text-zinc-300">Please confirm your age before continuing.</p> : null}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handleAccount}
              disabled={!agreed}
              className="vl-btn-primary vl-focus-ring rounded-full px-6 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Account / Sign In
            </button>
            <button
              type="button"
              onClick={handleEnter}
              disabled={!agreed}
              className="vl-btn-secondary vl-focus-ring rounded-full px-6 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue as Guest
            </button>
          </div>
          <p className="mt-5 text-xs leading-6 text-zinc-400">
            Create a free account to track orders and reorders, save your cart, and get member-only offers — or continue
            as a guest and check out with just your email.
          </p>
          <button
            type="button"
            onClick={handleExit}
            className="vl-focus-ring mt-4 text-xs text-zinc-500 underline-offset-4 transition hover:text-zinc-300 hover:underline"
          >
            I am under 21 — exit
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
