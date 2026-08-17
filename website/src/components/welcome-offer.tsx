"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Offer = { code: string; percent: number; headline: string; subtext: string };

const STORAGE_KEY = "vl_welcome_offer_dismissed";

/**
 * Dismissible first-order welcome banner. Shows only when the admin has enabled
 * a welcome offer, and stays dismissed per browser once closed.
 *
 * IT HAS TO BE FIXED, AND THE NAV HAS TO MOVE FOR IT. The site header is
 * `position: fixed` and transparent until you scroll, so it floats over the top
 * of the hero by design. This banner used to be an ordinary in-flow element at
 * the very top of the document, which put it underneath that fixed header at
 * exactly the same coordinates: the two drew through each other, the offer text
 * came out struck through by the nav links, and the copy-code button sat under
 * the header and could not be clicked. The banner was enabled and effectively
 * invisible.
 *
 * Raising its z-index alone would have been wrong — it would then cover the nav
 * permanently, including while scrolling. So the banner joins the header in the
 * fixed layer above it, and the header is pushed down by exactly the banner's
 * measured height while it is on screen. Both float over the hero, which is how
 * the nav already behaved.
 *
 * The height is measured rather than hardcoded because this copy wraps to two
 * lines on a narrow screen, and a guessed constant would put the nav back on
 * top of it at precisely the widths hardest to notice.
 */
export function WelcomeOffer() {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [copied, setCopied] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);

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

  // Publish the banner's real height so the fixed header can sit below it, and
  // take it away again the moment the banner goes. Re-measured on resize
  // because the copy re-wraps, and cleaned up on unmount so a dismissed banner
  // never leaves the nav pushed down over nothing.
  useEffect(() => {
    const root = document.documentElement;
    if (!offer) {
      root.style.removeProperty("--welcome-offer-height");
      document.body.removeAttribute("data-welcome-offer");
      return;
    }

    const measure = () => {
      const height = bannerRef.current?.offsetHeight ?? 0;
      root.style.setProperty("--welcome-offer-height", `${height}px`);
      document.body.setAttribute("data-welcome-offer", "true");
    };

    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      root.style.removeProperty("--welcome-offer-height");
      document.body.removeAttribute("data-welcome-offer");
    };
  }, [offer]);

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
    <div
      ref={bannerRef}
      className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-[color:var(--accent-gold-soft)] bg-[color:var(--accent-gold-soft)] py-2 pl-4 pr-12 text-center text-sm text-white"
    >
      <span className="font-semibold">{offer.headline}</span>
      <span className="text-white/70">{offer.subtext}</span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy discount code ${offer.code}`}
        className="rounded-full border border-[color:var(--accent-gold)] px-3 py-0.5 text-xs font-bold uppercase tracking-[0.08em] text-[color:var(--accent-gold)]"
      >
        <span aria-live="polite">{copied ? "✓ Copied" : `Code: ${offer.code}`}</span>
      </button>
      <Link href="/products" className="text-xs font-semibold text-white underline underline-offset-4">Shop now</Link>
      <button type="button" onClick={dismiss} aria-label="Dismiss offer" className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center text-lg text-white/60 hover:text-white">×</button>
    </div>
  );
}
