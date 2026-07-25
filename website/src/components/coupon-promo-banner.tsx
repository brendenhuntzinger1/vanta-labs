"use client";

import { useEffect, useState } from "react";

type FeaturedCoupon = {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  endsAt: string | null;
};

const DISMISS_PREFIX = "vl_promo_dismissed:";

function discountHeadline(coupon: FeaturedCoupon): string {
  if (coupon.discountType === "fixed") {
    // Trim a trailing .00 so "$20 OFF" reads cleaner than "$20.00 OFF".
    const value = Number.isInteger(coupon.discountValue) ? coupon.discountValue : coupon.discountValue.toFixed(2);
    return `$${value} OFF`;
  }
  return `${coupon.discountValue}% OFF`;
}

function endsLabel(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return null;
  return `Ends ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function CouponPromoBanner() {
  const [coupon, setCoupon] = useState<FeaturedCoupon | null>(null);
  const [visible, setVisible] = useState(false);
  const [entered, setEntered] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/coupons/featured", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (!active || !json?.coupon?.code) return;
        const next = json.coupon as FeaturedCoupon;
        // Respect a per-code dismissal: a shopper who closed THIS code won't
        // see it again, but a newly launched code still shows.
        let dismissed = false;
        try {
          dismissed = localStorage.getItem(`${DISMISS_PREFIX}${next.code}`) === "1";
        } catch {
          /* storage blocked — treat as not dismissed */
        }
        if (dismissed) return;
        setCoupon(next);
        setVisible(true);
        // Next frame -> trigger the entrance transition.
        requestAnimationFrame(() => active && setEntered(true));
      })
      .catch(() => {
        /* no promo shown on error */
      });
    return () => {
      active = false;
    };
  }, []);

  if (!visible || !coupon) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coupon.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the code is still visible to type manually */
    }
  };

  const dismiss = () => {
    try {
      localStorage.setItem(`${DISMISS_PREFIX}${coupon.code}`, "1");
    } catch {
      /* ignore */
    }
    setEntered(false);
    setTimeout(() => setVisible(false), 250);
  };

  const ends = endsLabel(coupon.endsAt);

  return (
    <div
      className={`relative mt-6 overflow-hidden rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-700 px-5 py-5 shadow-[0_16px_40px_-16px_rgba(16,185,129,0.7)] transition-all duration-300 ease-out sm:px-7 sm:py-6 ${
        entered ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0"
      }`}
      role="region"
      aria-label="Promo code"
    >
      {/* soft glow accents */}
      <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-white/15 blur-2xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-16 left-10 h-40 w-40 rounded-full bg-teal-300/20 blur-2xl" aria-hidden="true" />

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss promo"
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/15 hover:text-white"
      >
        ×
      </button>

      <div className="relative flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/80">Limited-time offer</p>
          <p className="mt-1 text-2xl font-extrabold leading-tight text-white sm:text-3xl">
            {discountHeadline(coupon)} your order
          </p>
          <p className="mt-1 text-sm text-white/85">
            Tap the code to copy, then paste it at checkout.
            {ends ? <span className="ml-1 font-medium text-white">· {ends}</span> : null}
          </p>
        </div>

        <button
          type="button"
          onClick={copy}
          className="group relative inline-flex shrink-0 items-center gap-3 rounded-xl border-2 border-dashed border-white/60 bg-white/10 px-4 py-3 backdrop-blur-sm transition hover:border-white hover:bg-white/20"
          aria-label={`Copy promo code ${coupon.code}`}
        >
          <span className="font-mono text-xl font-bold tracking-[0.18em] text-white sm:text-2xl">{coupon.code}</span>
          <span className="rounded-md bg-white px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-emerald-700 transition group-hover:bg-emerald-50">
            {copied ? "Copied!" : "Copy"}
          </span>
        </button>
      </div>
    </div>
  );
}
