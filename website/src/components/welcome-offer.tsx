"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Offer = { code: string; percent: number; headline: string; subtext: string };

const STORAGE_KEY = "vl_welcome_offer_dismissed";

// Dismissible first-order welcome banner. Shows only when the admin has
// enabled a welcome offer, and stays dismissed per browser once closed.
export function WelcomeOffer() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      /* ignore */
    }
    if (dismissed) return;

    (async () => {
      try {
        const res = await fetch("/api/catalog/welcome-offer", { cache: "no-store" });
        const data = (await res.json()) as { success: boolean; offer: Offer | null };
        if (data.success && data.offer) {
          setOffer(data.offer);
        }
      } catch {
        /* no banner if it fails */
      }
    })();
  }, []);

  if (!offer) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setOffer(null);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(offer.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* code is still visible */
    }
  };

  return (
    <div className="relative z-30 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)] px-4 py-2 text-center text-sm text-white">
      <span className="font-semibold">{offer.headline}</span>
      <span className="text-white/70">{offer.subtext}</span>
      <button
        type="button"
        onClick={copy}
        className="rounded-full border border-[color:var(--accent-gold)] px-3 py-0.5 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--accent-gold)]"
      >
        {copied ? "✓ Copied" : `Code: ${offer.code}`}
      </button>
      <Link href="/products" className="text-xs font-semibold text-white underline underline-offset-4">Shop now</Link>
      <button type="button" onClick={dismiss} aria-label="Dismiss offer" className="absolute right-2 top-1.5 text-white/50 hover:text-white">×</button>
    </div>
  );
}
