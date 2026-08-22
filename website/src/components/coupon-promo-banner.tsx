"use client";

import { useEffect, useState } from "react";
import { formatDisplayDate } from "@/lib/format-date";

export type FeaturedCoupon = {
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

/**
 * `initialCoupon` lets the SERVER decide whether this banner exists.
 *
 * Fetching it in the browser meant the banner rendered nothing, then dropped an
 * ~87px block into the middle of the page a few hundred milliseconds later,
 * shoving the product content down under the reader's eye — a measured layout
 * shift of 0.15 on the product page, and the "things jump around" complaint in
 * visible form.
 *
 * `undefined` means "the server did not resolve this" and preserves the
 * original client-fetch behaviour exactly, so any caller that has not been
 * updated keeps working. `null` means the server checked and there is no live
 * coupon — render nothing, and do not fetch.
 */
export function CouponPromoBanner({ initialCoupon }: { initialCoupon?: FeaturedCoupon | null } = {}) {
  const serverResolved = initialCoupon !== undefined;
  const [coupon, setCoupon] = useState<FeaturedCoupon | null>(initialCoupon ?? null);
  // A server-resolved banner is present in the very first paint, so it must not
  // start in the pre-entrance (translated, transparent) state.
  const [entered, setEntered] = useState(serverResolved);
  const [copied, setCopied] = useState(false);

  // The banner is intentionally NOT dismissible: it stays up for as long as the
  // coupon is live and disappears on its own once the coupon is no longer
  // active (the endpoint returns nothing), so shoppers never miss the offer.
  useEffect(() => {
    if (serverResolved) return;
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
  }, [serverResolved]);

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
      className={`relative mt-4 overflow-hidden rounded-xl border border-[color:var(--accent-gold)]/22 bg-black/70 px-4 py-2.5 shadow-[0_0_24px_-18px_rgba(199,174,94,0.55)] backdrop-blur transition-all duration-300 ease-out sm:px-5 sm:py-3 ${
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
      }`}
      role="region"
      aria-label="Promo code"
    >
      {/* The moving gold sheen that used to live here was removed. A promotion
          should be noticeable once, not animate for as long as the page is
          open — a permanent shimmer is the most template-looking thing that
          can happen to a dark storefront, and it costs a repaint per frame on
          exactly the phones this has to stay smooth on. */}

      <div className="relative flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-[0.24em] text-[color:var(--accent-gold)]/60 sm:text-[10px]">Limited-time offer</p>
          <p className="vl2-serif text-lg leading-tight text-white sm:text-2xl">
            {discountHeadline(coupon)} <span className="text-xs font-normal tracking-normal text-white/60 sm:text-sm">your order</span>
          </p>
          {ends ? <p className="text-[10px] text-white/40 sm:text-[11px]">{ends}</p> : null}
        </div>

        <button
          type="button"
          onClick={copy}
          className="group relative inline-flex shrink-0 items-center gap-2 rounded-full border border-[color:var(--accent-gold)]/30 bg-black/50 px-2.5 py-1.5 transition hover:border-[color:var(--accent-gold)]/60 hover:bg-[color:var(--accent-gold)]/[0.06] sm:px-3.5 sm:py-2"
          aria-label={`Copy promo code ${coupon.code}`}
        >
          <span className="font-mono text-xs font-bold tracking-[0.14em] text-[color:var(--accent-gold)] sm:text-base">{coupon.code}</span>
          <span className="rounded-full border border-[color:var(--accent-gold)]/35 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[color:var(--accent-gold)]/90 transition group-hover:border-[color:var(--accent-gold)]/70 sm:text-xs">
            {copied ? "✓" : "Copy"}
          </span>
        </button>
      </div>
    </div>
  );
}
