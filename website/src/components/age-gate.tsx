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
      <div className="flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.16),_transparent_55%),linear-gradient(135deg,_#020202_0%,_#111111_50%,_#050505_100%)] px-6 py-10 text-zinc-100">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1532187863486-abf9dbad1b69?auto=format&fit=crop&w=1600&q=80')] bg-cover bg-center opacity-20" />
        <div className="relative w-full max-w-2xl rounded-[2rem] border border-white/10 bg-white/10 p-8 text-center shadow-[0_0_80px_rgba(0,0,0,0.45)] backdrop-blur-xl xl:p-10">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full border border-white/20 bg-white/10 text-2xl font-semibold tracking-[0.3em] text-white">
            VL
          </div>
          <p className="mb-4 text-xs uppercase tracking-[0.45em] text-zinc-400">Restricted Access</p>
          <h1 className="text-4xl font-semibold tracking-[0.35em] text-white sm:text-5xl">VANTA LABS</h1>
          <p className="mt-4 text-lg text-zinc-300">Research Integrity. Verified Quality.</p>
          <p className="mt-8 text-xl font-medium text-white">Are you 21 years of age or older?</p>
          <label className="mt-6 flex items-start justify-center gap-3 rounded-[1.25rem] border border-white/10 bg-zinc-950/40 p-4 text-left text-sm text-zinc-300">
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
          {showPrompt ? <p className="mt-4 text-sm text-amber-300">Please confirm your age before continuing.</p> : null}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={handleEnter}
              disabled={!agreed}
              className="rounded-full border border-zinc-600 bg-white px-6 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Enter Site
            </button>
            <button
              type="button"
              onClick={handleExit}
              className="rounded-full border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-200 transition hover:bg-zinc-900"
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
