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
      className={`relative mt-4 overflow-hidden rounded-xl bg-gradient-to-r from-emerald-500 via-emerald-600 to-teal-700 px-3.5 py-2.5 shadow-[0_10px_24px_-14px_rgba(16,185,129,0.7)] transition-all duration-300 ease-out sm:px-5 sm:py-3 ${
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
      role="region"
      aria-label="Promo code"
    >
      {/* one subtle glow accent — kept small so the bar stays slim */}
      <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-white/15 blur-2xl" aria-hidden="true" />

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss promo"
        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-white/70 transition hover:bg-white/15 hover:text-white"
      >
        ×
      </button>

      <div className="relative flex items-center justify-between gap-3 pr-5">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/80 sm:text-[10px]">Limited-time offer</p>
          <p className="text-base font-extrabold leading-tight text-white sm:text-xl">
            {discountHeadline(coupon)} <span className="text-xs font-semibold text-white/85 sm:text-sm">your order</span>
          </p>
          {ends ? <p className="text-[10px] text-white/80 sm:text-[11px]">{ends}</p> : null}
        </div>

        <button
          type="button"
          onClick={copy}
          className="group relative inline-flex shrink-0 items-center gap-2 rounded-lg border border-dashed border-white/60 bg-white/10 px-2.5 py-1.5 backdrop-blur-sm transition hover:border-white hover:bg-white/20 sm:px-3 sm:py-2"
          aria-label={`Copy promo code ${coupon.code}`}
        >
          <span className="font-mono text-sm font-bold tracking-[0.12em] text-white sm:text-lg">{coupon.code}</span>
          <span className="rounded bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700 transition group-hover:bg-emerald-50 sm:text-xs">
            {copied ? "✓" : "Copy"}
          </span>
        </button>
      </div>
    </div>
  );
}
