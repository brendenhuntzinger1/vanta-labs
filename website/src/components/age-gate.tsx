"use client";

import { useState, useSyncExternalStore } from "react";

function getAgeVerifiedSnapshot() {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem("vanta-labs-age-verified") === "true";
  } catch (error) {
    console.error("Unable to read age verification state", error);
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

  const handleEnter = () => {
    if (!agreed) {
      setShowPrompt(true);
      return;
    }
    try {
      window.localStorage.setItem("vanta-labs-age-verified", "true");
    } catch (error) {
      console.error("Unable to save age verification state", error);
    }
    setLocalVerified(true);
  };

  const handleExit = () => {
    setLocalVerified(false);
    try {
      window.localStorage.removeItem("vanta-labs-age-verified");
    } catch (error) {
      console.error("Unable to clear age verification state", error);
    }
    window.location.assign("https://www.google.com");
  };

  if (!isVerified) {
    return (
      <div className="flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.16),_transparent_55%),linear-gradient(135deg,_#020202_0%,_#111111_50%,_#050505_100%)] px-4 py-8 text-zinc-100 sm:px-6 sm:py-10">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=1600&q=80')] bg-cover bg-center opacity-20" />
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
              onClick={handleEnter}
              disabled={!agreed}
              className="vl-btn-primary vl-focus-ring rounded-full px-6 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Enter Site
            </button>
            <button
              type="button"
              onClick={handleExit}
              className="vl-btn-secondary vl-focus-ring rounded-full px-6 py-3 text-sm"
            >
              Exit Site
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
