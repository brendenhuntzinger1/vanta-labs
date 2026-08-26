"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { formatCartCurrency, useCart, getShippingProgress } from "@/components/cart-context";
import { bundleDiscountRate, getBundleDiscountedLineTotal, getNextBundleTier } from "@/lib/bundle-pricing";
import { bestPaidTier, computeCartMembershipValue } from "@/lib/member-pricing";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { FREE_SHIPPING_THRESHOLD } from "@/lib/shipping";
import { EXPRESS_CHECKOUT_ENABLED } from "@/lib/express-checkout";
import { ExpressApplePayButton } from "@/components/express-apple-pay-button";
import { BacWaterCartCheckboxes } from "@/components/bac-water-upsell";
import { FULFILMENT_DETAIL } from "@/lib/trust-claims";
import {
  REQUIRED_CONFIRMATIONS,
  defaultAcknowledgements,
  type AcknowledgementKey,
} from "@/lib/checkout-confirmations";

// A gentle tap on supported devices (Android/Chrome). No-op on iOS Safari and
// anywhere Vibration isn't available — never throws, never blocks.
function haptic(ms = 8) {
  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try { navigator.vibrate(ms); } catch { /* ignore */ }
  }
}

// Smooth, CLS-free expand/collapse: animate grid-template-rows 0fr→1fr with the
// content clipped inside. GPU-friendly, no height measuring, no layout jump.
//
// `inert` when closed is load-bearing: `overflow: hidden` clips content visually
// but leaves it focusable and exposed to screen readers, so without it a
// keyboard user tabs into collapsed, invisible controls.
function Collapse({ open, children, className = "" }: { open: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"} ${className}`}
    >
      <div className="overflow-hidden" inert={!open}>{children}</div>
    </div>
  );
}

export function CartDrawer() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  const [couponInput, setCouponInput] = useState("");
  // Derived from REQUIRED_CONFIRMATIONS so a statement added to that list is
  // automatically required here too — the list is the single source of truth
  // for what a shopper must accept, and the server enforces the same set.
  const [acknowledgements, setAcknowledgements] =
    useState<Record<AcknowledgementKey, boolean>>(defaultAcknowledgements);
  // Collapsible sections — everything the majority of shoppers don't need stays
  // out of the way until asked for. Legal detail, protection detail, and the
  // code fields are each one tap from view.
  const [codesOpen, setCodesOpen] = useState(false);
  const [protectionOpen, setProtectionOpen] = useState(false);
  const [openLegal, setOpenLegal] = useState<Record<string, boolean>>({});
  // Flash the confirmations card if a shopper taps Apple Pay before ticking the
  // boxes, and scroll it into view so they see exactly what's blocking payment.
  const [highlightConfirm, setHighlightConfirm] = useState(false);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  // Set when the express lane reports it can't run here (wrong platform,
  // unregistered host, or a cart this lane can't price). The drawer then falls
  // back to exactly what it showed before the express slot existed.
  const [expressUnavailable, setExpressUnavailable] = useState(false);
  const {
    items,
    isCartOpen,
    isHydrated,
    bundleConfig,
    shippingProtectionEnabled,
    setShippingProtectionEnabled,
    shippingProtectionFee,
    closeCart,
    updateQuantity,
    removeFromCart,
    subtotal,
    shipping,
    discountAmount,
    appliedDiscountLabel,
    autoBestDiscountApplied,
    total,
    referralCode,
    referralStatusText,
    referralNeedsMoreToQualify,
    referralError,
    referralSuccess,
    applyReferralCode,
    clearReferralCode,
    isApplyingReferral,
    couponCode,
    couponDetails,
    couponError,
    couponSuccess,
    applyCouponCode,
    clearCouponCode,
    isApplyingCoupon,
    isBuy3Get1FreeEligible,
    buy3Get1UntilNextFree,
    bulkSavingsApplied,
    bulkSavingsPercent,
    bulkSavingsProgress,
    membershipTiers,
    memberDiscountPercent,
    shippingConfig,
  } = useCart();

  const freeShipThreshold = shippingConfig.freeShippingThreshold;
  const shippingProgress = getShippingProgress(subtotal, freeShipThreshold);

  // Smart membership upsell: only for non-members, and only when joining
  // would genuinely put money in their pocket TODAY (cart savings + credit
  // exceed the first month's cost). Dollars, computed live from this cart.
  const upsellTier = memberDiscountPercent > 0 ? null : bestPaidTier(membershipTiers);
  const membershipValue = upsellTier
    ? computeCartMembershipValue({ subtotal, shipping, tier: upsellTier })
    : null;
  const showMembershipUpsell = Boolean(upsellTier && membershipValue && membershipValue.todayValue > 0 && subtotal > 0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Auto-reveal the code fields when a code becomes applied, so an applied code
  // is never hidden behind a collapsed row — while still letting the shopper
  // collapse it again afterwards.
  //
  // Adjusted DURING RENDER rather than in an effect (React's documented
  // "adjusting state when props change" pattern): one render pass instead of
  // two, and unlike deriving `codesOpen` outright it does not trap the row open.
  const codesKey = `${referralCode ?? ""}|${couponCode ?? ""}`;
  const [prevCodesKey, setPrevCodesKey] = useState(codesKey);
  if (codesKey !== prevCodesKey) {
    setPrevCodesKey(codesKey);
    if (referralCode || couponCode) setCodesOpen(true);
  }

  // Accessible modal behavior: move focus into the drawer on open, trap Tab
  // within it, close on Escape, lock body scroll, and restore focus on close.
  useEffect(() => {
    if (!isCartOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCart();
        return;
      }
      if (event.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [isCartOpen, closeCart]);

  const effectiveReferralInput = referralInput || referralCode || "";
  const effectiveCouponInput = couponInput || couponCode || "";

  const handleContinueToCheckout = () => {
    haptic(10);
    closeCart();
    router.push("/checkout");
  };

  const acknowledgedCount = REQUIRED_CONFIRMATIONS.filter((item) => acknowledgements[item.key]).length;
  const allAcknowledged = acknowledgedCount === REQUIRED_CONFIRMATIONS.length;
  // The express slot is only worth its footer real estate once the lane has
  // proven it can actually run. onUnavailable is how it says it can't.
  const showExpressSlot = EXPRESS_CHECKOUT_ENABLED && !expressUnavailable;
  const onUnavailable = useCallback(() => setExpressUnavailable(true), []);

  // Draw attention to the confirmations when Apple Pay is tapped early.
  const flagConfirmations = useCallback(() => {
    if (allAcknowledged) return;
    setHighlightConfirm(true);
    confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setHighlightConfirm(false), 2200);
  }, [allAcknowledged]);

  const toggleLegal = (key: string) => setOpenLegal((prev) => ({ ...prev, [key]: !prev[key] }));

  if (!isCartOpen) {
    return null;
  }

  const hasItems = isHydrated && items.length > 0;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/75 backdrop-blur-[3px] animate-[vl-fade-backdrop_0.28s_ease-out]"
        aria-label="Close cart drawer"
        onClick={closeCart}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-white/[0.06] bg-[#0a0a0a]/95 shadow-[0_0_60px_rgba(0,0,0,0.7)] backdrop-blur-2xl animate-[vl-drawer-in-mobile_0.34s_cubic-bezier(0.2,0.8,0.2,1)] sm:my-4 sm:mr-4 sm:h-auto sm:max-h-[calc(100%-2rem)] sm:rounded-[1.75rem] sm:border sm:animate-[vl-drawer-in-desktop_0.34s_cubic-bezier(0.2,0.8,0.2,1)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 sm:px-6">
          <div>
            <p className="text-[10px] uppercase tracking-[0.34em] text-zinc-500">Cart</p>
            <h2 id="cart-drawer-title" className="mt-1.5 text-[1.65rem] font-semibold leading-none tracking-tight text-white">Your order</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeCart}
            aria-label="Close cart"
            className="vl-focus-ring -mr-1.5 inline-flex h-11 w-11 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-white active:scale-95"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-5 w-5"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="h-px bg-white/[0.06]" />

        {/* Scroll region */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {isHydrated && items.length === 0 ? (
            <div className="flex flex-col items-center rounded-[1.5rem] border border-white/[0.06] bg-white/[0.02] px-6 py-14 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03]">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-6 w-6 text-zinc-500"><path d="M6 6h15l-1.5 9h-12z" strokeLinejoin="round" /><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M6 6 5 3H3" strokeLinecap="round" /></svg>
              </div>
              <p className="mt-5 text-lg font-medium text-white">Your cart is empty</p>
              <p className="mt-2 text-sm text-zinc-500">Add products to begin building an order.</p>
              <Link
                href="/products"
                onClick={closeCart}
                className="vl-focus-ring mt-7 inline-flex items-center justify-center rounded-full bg-white px-7 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200 active:scale-[0.98]"
              >
                Browse products
              </Link>
            </div>
          ) : hasItems ? (
            <div className="space-y-5">
              {/* Free shipping progress card */}
              {subtotal > 0 ? (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                  {shippingProgress.isEligibleForFreeShipping ? (
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[color:var(--accent-gold)]/30 bg-[color:var(--accent-gold)]/10">
                        <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-gold)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M20 6 9 17l-5-5" /></svg>
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">Free shipping unlocked</p>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                          <div className="h-full rounded-full" style={{ width: "100%", background: "linear-gradient(90deg, rgba(199, 174, 94,0.6), var(--accent-gold))" }} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm text-zinc-400">
                          You&apos;re <span className="font-semibold text-white">${shippingProgress.amountToFreeShipping.toFixed(2)}</span> away from
                        </p>
                        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500 tabular-nums">{Math.round(shippingProgress.progressPercentage)}%</span>
                      </div>
                      <p className="mt-0.5 text-xs font-semibold uppercase tracking-[0.24em] text-[color:var(--accent-gold)]">Free shipping</p>
                      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                        <div
                          className="h-full rounded-full transition-[width] duration-500 ease-out"
                          style={{ width: `${shippingProgress.progressPercentage}%`, background: "linear-gradient(90deg, rgba(199, 174, 94,0.55), var(--accent-gold))" }}
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {/* Product cards */}
              <div className="space-y-3">
                {items.map((item) => {
                  const activeRate = bundleDiscountRate(item.quantity, bundleConfig);
                  const nextTier = getNextBundleTier(item.quantity, bundleConfig);
                  const lineTotal = getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig);
                  const fullTotal = item.price * item.quantity;
                  const subtitle = [item.doseLabel, item.batchNumber ? `Batch ${item.batchNumber}` : ""].filter(Boolean).join(" · ");
                  return (
                    <div key={item.key} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                      <div className="flex gap-4">
                        <div className="relative h-[4.5rem] w-[4.5rem] flex-shrink-0 overflow-hidden rounded-xl border border-white/[0.06] bg-black/40">
                          {item.image ? (
                            <Image src={item.image} alt={item.name} fill sizes="72px" className="object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-600">No image</div>
                          )}
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <h3 className="truncate text-sm font-semibold text-white">{item.name}</h3>
                              {subtitle ? <p className="mt-0.5 truncate text-xs text-zinc-500">{subtitle}</p> : null}
                            </div>
                            <div className="flex-shrink-0 text-right">
                              {activeRate > 0 ? (
                                <p className="text-[11px] text-zinc-600 line-through tabular-nums">{formatCartCurrency(fullTotal)}</p>
                              ) : null}
                              <p className="text-sm font-semibold text-white tabular-nums">{formatCartCurrency(lineTotal)}</p>
                            </div>
                          </div>

                          {activeRate > 0 ? (
                            <span className="mt-2 inline-flex w-fit items-center rounded-full border border-[color:var(--accent-gold)]/25 bg-[color:var(--accent-gold)]/[0.08] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--accent-gold)]">
                              {Math.round(activeRate * 100)}% bundle savings
                            </span>
                          ) : null}

                          <div className="mt-3 flex items-center justify-between">
                            <div className="flex items-center rounded-full border border-white/[0.08] bg-black/30">
                              <button
                                type="button"
                                onClick={() => { haptic(); updateQuantity(item.key, item.quantity - 1); }}
                                className="vl-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-l-full text-base text-zinc-300 transition hover:text-white active:scale-90 sm:h-9 sm:w-9"
                                aria-label={`Decrease ${item.name} quantity`}
                              >
                                −
                              </button>
                              <span className="min-w-8 text-center text-sm font-semibold tabular-nums text-white">{item.quantity}</span>
                              <button
                                type="button"
                                onClick={() => { haptic(); updateQuantity(item.key, item.quantity + 1); }}
                                className="vl-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-r-full text-base text-zinc-300 transition hover:text-white active:scale-90 sm:h-9 sm:w-9"
                                aria-label={`Increase ${item.name} quantity`}
                              >
                                +
                              </button>
                            </div>
                            <button
                              type="button"
                              onClick={() => { haptic(12); removeFromCart(item.key); }}
                              aria-label={`Remove ${item.name} from cart`}
                              className="vl-focus-ring -mx-1 inline-flex min-h-11 items-center rounded-md px-3 py-1.5 text-xs text-zinc-500 transition hover:text-rose-300 sm:mx-0 sm:min-h-0 sm:px-2"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </div>

                      {nextTier ? (
                        <button
                          type="button"
                          onClick={() => { haptic(); updateQuantity(item.key, item.quantity + nextTier.addMore); }}
                          className="vl-focus-ring mt-3 flex w-full items-center justify-between rounded-xl border border-[color:var(--accent-gold)]/20 bg-[color:var(--accent-gold)]/[0.05] px-3.5 py-2.5 text-left transition hover:border-[color:var(--accent-gold)]/40 hover:bg-[color:var(--accent-gold)]/[0.09] active:scale-[0.99]"
                        >
                          <span className="text-xs text-zinc-300">
                            Buy <span className="font-semibold text-white">{nextTier.addMore} more</span> and save <span className="font-semibold text-[color:var(--accent-gold)]">{nextTier.percent}%</span>
                          </span>
                          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--accent-gold)]/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--accent-gold)]">Add</span>
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* Promotions & nudges — quiet charcoal cards, gold/emerald accents only */}
              <BacWaterCartCheckboxes />

              {isBuy3Get1FreeEligible ? (
                <div className="rounded-2xl border border-[color:var(--accent-gold)]/20 bg-[color:var(--accent-gold)]/[0.05] p-4">
                  <p className="text-sm font-semibold text-[color:var(--accent-gold)]">Buy 3, Get 1 Free — active</p>
                  <p className="mt-1.5 text-xs text-zinc-400">Your lowest-priced eligible item is free. Referral discounts pause while this promotion applies.</p>
                </div>
              ) : null}

              {buy3Get1UntilNextFree > 0 ? (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <p className="text-sm text-zinc-300">
                    Add <span className="font-semibold text-[color:var(--accent-gold)]">{buy3Get1UntilNextFree} more {buy3Get1UntilNextFree === 1 ? "item" : "items"}</span> to unlock a free item.
                  </p>
                </div>
              ) : null}

              {showMembershipUpsell && upsellTier && membershipValue ? (
                <Link
                  href="/membership"
                  onClick={closeCart}
                  className="vl-focus-ring block rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4 transition hover:border-emerald-400/40"
                >
                  <p className="text-sm font-semibold text-emerald-300">
                    Save {formatCartCurrency(membershipValue.totalBenefit)} today with {upsellTier.name}
                  </p>
                  <p className="mt-1 text-xs text-emerald-100/50">
                    {formatCartCurrency(membershipValue.discountSavings)} off this cart
                    {membershipValue.shippingSavings > 0 ? ` + free shipping` : ""}
                    {membershipValue.monthlyStoreCredit > 0 ? ` + ${formatCartCurrency(membershipValue.monthlyStoreCredit)} monthly credit` : ""}
                    {" · "}{formatCartCurrency(membershipValue.monthlyCost)}/mo — join →
                  </p>
                </Link>
              ) : null}

              {bulkSavingsApplied ? (
                <div className="rounded-2xl border border-[color:var(--accent-gold)]/20 bg-[color:var(--accent-gold)]/[0.05] p-4">
                  <p className="text-sm font-semibold text-[color:var(--accent-gold)]">Member bulk discount applied</p>
                  <p className="mt-1 text-xs text-zinc-400">{bulkSavingsPercent}% off this order.</p>
                </div>
              ) : null}

              {!bulkSavingsApplied && bulkSavingsProgress ? (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                  <p className="text-sm text-zinc-300">
                    You&apos;re {formatCartCurrency(bulkSavingsProgress.amountRemaining)} away from <span className="font-semibold text-white">{bulkSavingsProgress.nextPercent}% off</span>.
                  </p>
                </div>
              ) : null}

              {/* Referral & coupon — collapsed by default */}
              {!isBuy3Get1FreeEligible ? (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                  <button
                    type="button"
                    onClick={() => setCodesOpen((o) => !o)}
                    aria-expanded={codesOpen}
                    className="vl-focus-ring flex w-full items-center justify-between px-4 py-3.5 text-left"
                  >
                    <span className="text-sm text-zinc-300">Have a referral or coupon code?</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`h-4 w-4 text-zinc-500 transition-transform duration-300 ${codesOpen ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
                  </button>
                  <Collapse open={codesOpen}>
                    <div className="space-y-4 px-4 pb-4">
                      <div>
                        <label className="mb-1.5 block text-[10px] uppercase tracking-[0.24em] text-zinc-500">Referral code</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={effectiveReferralInput}
                            onChange={(event) => setReferralInput(event.target.value)}
                            placeholder="VANTA10"
                            className="vl-input flex-1 px-4 py-2.5 text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => applyReferralCode(effectiveReferralInput)}
                            disabled={isApplyingReferral}
                            className="vl-focus-ring rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 text-xs font-semibold uppercase tracking-wide text-zinc-200 transition hover:bg-white/[0.08] disabled:opacity-50"
                          >
                            {isApplyingReferral ? "…" : "Apply"}
                          </button>
                        </div>
                        {referralSuccess ? <p className="mt-1.5 text-xs text-emerald-400">{referralSuccess}</p> : null}
                        {referralError ? <p className="mt-1.5 text-xs text-rose-400">{referralError}</p> : null}
                        {referralStatusText ? (
                          <p className="mt-1.5 flex items-start justify-between gap-2 text-xs text-zinc-400">
                            {/* The non-qualifying sentence is a full line of prose, not a name and
                                a percentage. At 390px it wraps, and without flex-shrink-0 the
                                Remove button was squeezed onto its own wrapped characters. */}
                            <span className={referralNeedsMoreToQualify ? "text-amber-300/80" : undefined}>{referralStatusText}</span>
                            <button type="button" onClick={clearReferralCode} className="flex-shrink-0 text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">Remove</button>
                          </p>
                        ) : null}
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] uppercase tracking-[0.24em] text-zinc-500">Coupon code</label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={effectiveCouponInput}
                            onChange={(event) => setCouponInput(event.target.value)}
                            placeholder="LAUNCH"
                            className="vl-input flex-1 px-4 py-2.5 text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => applyCouponCode(effectiveCouponInput)}
                            disabled={isApplyingCoupon}
                            className="vl-focus-ring rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 text-xs font-semibold uppercase tracking-wide text-zinc-200 transition hover:bg-white/[0.08] disabled:opacity-50"
                          >
                            {isApplyingCoupon ? "…" : "Apply"}
                          </button>
                        </div>
                        {couponSuccess ? <p className="mt-1.5 text-xs text-emerald-400">{couponSuccess}</p> : null}
                        {couponError ? <p className="mt-1.5 text-xs text-rose-400">{couponError}</p> : null}
                        {couponDetails ? (
                          <p className="mt-1.5 flex items-center justify-between text-xs text-zinc-400">
                            <span>{couponDetails.code} · {couponDetails.discountType === "fixed" ? formatCartCurrency(couponDetails.discountValue) : `${couponDetails.discountValue}%`} off</span>
                            <button type="button" onClick={clearCouponCode} className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">Remove</button>
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </Collapse>
                </div>
              ) : null}

              {/* Shipping protection — one compact row, details on demand */}
              {subtotal > 0 ? (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-3.5">
                    <input
                      type="checkbox"
                      checked={shippingProtectionEnabled}
                      onChange={(e) => { haptic(); setShippingProtectionEnabled(e.target.checked); }}
                      className="h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-[color:var(--accent-gold)]"
                      aria-label="Add shipping protection"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-white">Shipping protection</span>
                      <span className="block text-xs text-zinc-500">Protect against loss, theft, or damage.</span>
                    </span>
                    <span className="flex-shrink-0 text-sm font-medium text-zinc-300 tabular-nums">+{formatCartCurrency(calculateShippingProtectionFee(subtotal))}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setProtectionOpen((o) => !o)}
                    aria-expanded={protectionOpen}
                    className="vl-focus-ring px-4 pb-1 text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300"
                  >
                    {protectionOpen ? "Hide details" : "View details"}
                  </button>
                  <Collapse open={protectionOpen}>
                    <p className="px-4 pb-4 pt-1 text-xs leading-relaxed text-zinc-500">
                      Store-backed coverage: we&apos;ll replace or refund items lost, stolen, or damaged in transit — no claim runaround.{" "}
                      <a href="/legal/shipping" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-zinc-300">See terms</a>
                    </p>
                  </Collapse>
                </div>
              ) : null}

              {/* Legal confirmations — required only for the Apple Pay express lane */}
              {showExpressSlot ? (
                <div
                  ref={confirmRef}
                  className={`rounded-2xl border bg-white/[0.02] transition-all duration-300 ${highlightConfirm && !allAcknowledged ? "border-[color:var(--accent-gold)]/60 shadow-[0_0_0_3px_rgba(199,174,94,0.18)]" : allAcknowledged ? "border-white/[0.06]" : "border-[color:var(--accent-gold)]/25"}`}
                >
                  <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
                    <p className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">Required to purchase</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums ${allAcknowledged ? "bg-emerald-400/12 text-emerald-300" : "bg-[color:var(--accent-gold)]/12 text-[color:var(--accent-gold)]"}`}>
                      {acknowledgedCount} of {REQUIRED_CONFIRMATIONS.length}
                    </span>
                  </div>
                  <div className="divide-y divide-white/[0.05]">
                    {REQUIRED_CONFIRMATIONS.map((item) => (
                      <div key={item.key} className="px-4 py-2.5">
                        <label className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={acknowledgements[item.key]}
                            onChange={(event) => { haptic(); setAcknowledgements((current) => ({ ...current, [item.key]: event.target.checked })); }}
                            className="h-[1.15rem] w-[1.15rem] flex-shrink-0 accent-emerald-500"
                          />
                          <span className="flex-1 text-sm text-zinc-200">{item.short}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); toggleLegal(item.key); }}
                            className="vl-focus-ring flex-shrink-0 text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300"
                          >
                            {openLegal[item.key] ? "Hide" : "View details"}
                          </button>
                        </label>
                        <Collapse open={Boolean(openLegal[item.key])}>
                          <p className="pl-8 pr-1 pt-2 text-xs leading-relaxed text-zinc-500">
                            {item.body}
                            {item.policyHref ? (
                              <>
                                {" "}
                                <Link
                                  href={item.policyHref}
                                  onClick={closeCart}
                                  className="vl-focus-ring text-[color:var(--accent-gold)] underline underline-offset-2"
                                >
                                  {item.policyLabel ?? "Read the full policy"}
                                </Link>
                              </>
                            ) : null}
                          </p>
                        </Collapse>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Trust row */}
              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                {[
                  { icon: <path d="M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5z" strokeLinejoin="round" />, label: "Secure checkout" },
                  { icon: <><path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" strokeLinejoin="round" /><path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" /></>, label: "256-bit SSL" },
                  { icon: <><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7z" strokeLinejoin="round" /><circle cx="7" cy="17" r="1.6" /><circle cx="17.5" cy="17" r="1.6" /></>, label: FULFILMENT_DETAIL },
                  { icon: <><path d="M9 3h6M10 3v5l-4 9a2 2 0 0 0 1.8 2.9h8.4A2 2 0 0 0 18 17l-4-9V3" strokeLinejoin="round" /></>, label: "Research use only" },
                ].map((t) => (
                  <div key={t.label} className="flex items-center gap-2.5">
                    <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent-gold)" strokeWidth="1.4" className="h-4 w-4 flex-shrink-0 opacity-80">{t.icon}</svg>
                    <span className="text-[11px] leading-tight text-zinc-400">{t.label}</span>
                  </div>
                ))}
              </div>

              {/* Order summary / total */}
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                <dl className="space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-zinc-400">Subtotal</dt>
                    <dd className="text-zinc-200 tabular-nums">{formatCartCurrency(subtotal)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-zinc-400">Shipping</dt>
                    <dd className="text-zinc-200 tabular-nums">{shipping > 0 ? formatCartCurrency(shipping) : "Calculated at payment"}</dd>
                  </div>
                  {discountAmount > 0 ? (
                    <div className="flex justify-between text-emerald-400">
                      <dt>{appliedDiscountLabel ?? "Discount"}</dt>
                      <dd className="tabular-nums">−{formatCartCurrency(discountAmount)}</dd>
                    </div>
                  ) : null}
                  {shippingProtectionFee > 0 ? (
                    <div className="flex justify-between">
                      <dt className="text-zinc-400">Shipping protection</dt>
                      <dd className="text-zinc-200 tabular-nums">+{formatCartCurrency(shippingProtectionFee)}</dd>
                    </div>
                  ) : null}
                </dl>
                {autoBestDiscountApplied ? (
                  <p className="mt-3 text-[11px] text-emerald-300/70">✓ Your best available discount was applied automatically.</p>
                ) : null}
                <div className="my-4 h-px bg-white/[0.06]" />
                <div className="flex items-end justify-between">
                  <span className="text-xs uppercase tracking-[0.24em] text-zinc-500">Total</span>
                  <span className="text-[2rem] font-semibold leading-none tracking-tight text-white tabular-nums">{formatCartCurrency(total)}</span>
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
                  Shipping &amp; sales tax are calculated from your address at payment. Free shipping over {formatCartCurrency(FREE_SHIPPING_THRESHOLD)}.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Sticky pay bar — always in reach */}
        {hasItems ? (
          <div className="vl-drawer-paybar border-t border-white/[0.06] bg-[#0a0a0a]/95 px-5 pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] backdrop-blur-2xl sm:px-6">
            <div className="mb-1 flex items-baseline justify-between">
              {/* With express on, this figure is pre-tax: the wallet sheet adds
                  sales tax and shipping once it has the address. Labelling it
                  "Total" there would read as a bait-and-switch when Apple Pay
                  shows a higher number. */}
              <span className="text-xs uppercase tracking-[0.24em] text-zinc-500">{showExpressSlot ? "Subtotal" : "Total"}</span>
              <span className="text-xl font-semibold text-white tabular-nums">{formatCartCurrency(total)}</span>
            </div>

            {showExpressSlot ? (
              <p className="mb-3 flex items-start gap-1.5 text-[11px] leading-snug text-zinc-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mt-[0.15rem] h-3.5 w-3.5 flex-shrink-0" aria-hidden>
                  <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" />
                </svg>
                <span>
                  Apple Pay adds <span className="text-zinc-300">sales tax</span> and shipping from your delivery address, so your final total there may be higher.
                  {" "}Free shipping over {formatCartCurrency(FREE_SHIPPING_THRESHOLD)}.
                </span>
              </p>
            ) : (
              <div className="mb-3" />
            )}

            <div className="space-y-3">
              {showExpressSlot ? (
                <>
                  {!allAcknowledged ? (
                    <button
                      type="button"
                      onClick={flagConfirmations}
                      className="vl-focus-ring w-full text-center text-[11px] text-[color:var(--accent-gold)]/90 underline-offset-2 hover:underline"
                    >
                      Tick the {REQUIRED_CONFIRMATIONS.length - acknowledgedCount} required {REQUIRED_CONFIRMATIONS.length - acknowledgedCount === 1 ? "box" : "boxes"} above to pay with Apple Pay
                    </button>
                  ) : null}
                  <div onClickCapture={() => { if (!allAcknowledged) flagConfirmations(); }}>
                    <ExpressApplePayButton
                      acknowledged={allAcknowledged}
                      acknowledgements={acknowledgements}
                      onUnavailable={onUnavailable}
                    />
                  </div>
                  <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.28em] text-zinc-600">
                    <span className="h-px flex-1 bg-white/[0.08]" />or<span className="h-px flex-1 bg-white/[0.08]" />
                  </div>
                </>
              ) : null}

              <button
                type="button"
                onClick={handleContinueToCheckout}
                className="vl-focus-ring flex w-full items-center justify-center rounded-full bg-white px-6 py-4 text-sm font-semibold tracking-wide text-black transition hover:bg-zinc-200 active:scale-[0.985]"
              >
                Proceed to checkout
              </button>

              {referralCode ? (
                <button
                  type="button"
                  onClick={() => { clearReferralCode(); setReferralInput(""); }}
                  className="vl-focus-ring w-full py-1 text-center text-[11px] text-zinc-500 hover:text-zinc-300"
                >
                  Remove code
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
