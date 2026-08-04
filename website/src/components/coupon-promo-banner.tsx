"use client";

import { useEffect, useState } from "react";
import { formatDisplayDate } from "@/lib/format-date";

type FeaturedCoupon = {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  endsAt: string | null;
};

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
  const label = formatDisplayDate(endsAt, "short");
  return label ? `Ends ${label}` : null;
}

export function CouponPromoBanner() {
  const [coupon, setCoupon] = useState<FeaturedCoupon | null>(null);
  const [entered, setEntered] = useState(false);
  const [copied, setCopied] = useState(false);

  // The banner is intentionally NOT dismissible: it stays up for as long as the
  // coupon is live and disappears on its own once the coupon is no longer
  // active (the endpoint returns nothing), so shoppers never miss the offer.
  useEffect(() => {
    let active = true;
    fetch("/api/coupons/featured", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (!active || !json?.coupon?.code) return;
        setCoupon(json.coupon as FeaturedCoupon);
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

  if (!coupon) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coupon.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the code is still visible to type manually */
    }
  };

  const ends = endsLabel(coupon.endsAt);

  // Black glass panel with a fine gold border, serif gold headline, and a
  // slow gold sheen sweeping across — matches the site's premium black/serif
  // aesthetic while still being the one thing on the page that glints.
  return (
    <div
      className={`relative mt-4 overflow-hidden rounded-xl border border-[color:var(--accent-gold)]/40 bg-black/60 px-4 py-2.5 shadow-[0_0_34px_-12px_rgba(232,213,164,0.5)] backdrop-blur transition-all duration-300 ease-out sm:px-5 sm:py-3 ${
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
      role="region"
      aria-label="Promo code"
    >
      {/* moving gold sheen (disabled by prefers-reduced-motion in globals) */}
      <div className="vl-gold-sheen pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent-gold)]/60 sm:text-[10px]">Limited-time offer</p>
          <p className="vl2-serif text-lg leading-tight text-[color:var(--accent-gold)] sm:text-2xl">
            {discountHeadline(coupon)} <span className="text-xs font-normal tracking-normal text-white/60 sm:text-sm">your order</span>
          </p>
          {ends ? <p className="text-[10px] text-white/40 sm:text-[11px]">{ends}</p> : null}
        </div>

        <button
          type="button"
          onClick={copy}
          className="group relative inline-flex shrink-0 items-center gap-2 rounded-full border border-dashed border-[color:var(--accent-gold)]/50 bg-black/40 px-2.5 py-1.5 transition hover:border-[color:var(--accent-gold)] hover:bg-[color:var(--accent-gold)]/10 sm:px-3.5 sm:py-2"
          aria-label={`Copy promo code ${coupon.code}`}
        >
          <span className="font-mono text-xs font-bold tracking-[0.14em] text-[color:var(--accent-gold)] sm:text-base">{coupon.code}</span>
          <span className="rounded-full bg-[color:var(--accent-gold)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black transition group-hover:bg-[color:var(--accent-gold)] sm:text-xs">
            {copied ? "✓" : "Copy"}
          </span>
        </button>
      </div>
    </div>
  );
}
