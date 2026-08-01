"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { formatCartCurrency, useCart, getShippingProgress } from "@/components/cart-context";
import { bundleDiscountRate, getBundleDiscountedLineTotal, getNextBundleTier } from "@/lib/bundle-pricing";
import { bestPaidTier, computeCartMembershipValue } from "@/lib/member-pricing";
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";
import { EXPRESS_CHECKOUT_ENABLED } from "@/lib/express-checkout";
import { ExpressApplePayButton } from "@/components/express-apple-pay-button";
import { BacWaterCartCheckboxes } from "@/components/bac-water-upsell";

// Byte-identical to the copy on /checkout. This wording is legally
// load-bearing: reuse it verbatim, never reword it, never merge the three into
// one, never pre-tick a box.
const REQUIRED_CONFIRMATIONS = [
  {
    key: "researchResponsibility" as const,
    title: "Research Responsibility Statement *",
    body: "The purchaser assumes full responsibility for the proper handling, storage, and use of these laboratory materials. The seller provides products solely as research reference materials and does not provide medical or dosing guidance.",
  },
  {
    key: "researchCompliance" as const,
    title: "Research & Compliance Agreement *",
    body: "I acknowledge that the products sold on this website are intended strictly for laboratory research purposes. I confirm that I am purchasing these materials for legitimate research use and not for human or veterinary use. I understand these products are not drugs, dietary supplements, or medical products, and no instructions for preparation, dosage, or administration are provided by the seller.",
  },
  {
    key: "ageLegalConfirmation" as const,
    title: "Age & Legal Confirmation *",
    body: "I confirm that I am 21 years of age or older and legally permitted to purchase laboratory research materials.",
  },
];

export function CartDrawer() {
  const router = useRouter();
  const [referralInput, setReferralInput] = useState("");
  const [couponInput, setCouponInput] = useState("");
  const [acknowledgements, setAcknowledgements] = useState({
    researchResponsibility: false,
    researchCompliance: false,
    ageLegalConfirmation: false,
  });
  const [confirmationsOpen, setConfirmationsOpen] = useState(false);
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
    referralDetails,
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
    closeCart();
    router.push("/checkout");
  };

  const acknowledgedCount = REQUIRED_CONFIRMATIONS.filter((item) => acknowledgements[item.key]).length;
  const allAcknowledged = acknowledgedCount === REQUIRED_CONFIRMATIONS.length;
  // The express slot is only worth its footer real estate once the lane has
  // proven it can actually run. onUnavailable is how it says it can't.
  const showExpressSlot = EXPRESS_CHECKOUT_ENABLED && !expressUnavailable;
  const onUnavailable = useCallback(() => setExpressUnavailable(true), []);

  if (!isCartOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex justify-end px-0 py-0 sm:px-4 sm:py-4">
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px] animate-[vl-fade-backdrop_0.28s_ease-out]"
        aria-label="Close cart drawer"
        onClick={closeCart}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        className="vl-panel relative z-10 flex h-full w-full max-w-xl flex-col rounded-none p-4 shadow-2xl animate-[vl-drawer-in-mobile_0.32s_cubic-bezier(0.2,0.8,0.2,1)] sm:rounded-[2rem] sm:p-6 sm:animate-[vl-drawer-in-desktop_0.32s_cubic-bezier(0.2,0.8,0.2,1)]"
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500">Cart</p>
            <h2 id="cart-drawer-title" className="mt-2 text-2xl font-semibold text-white">Your order</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={closeCart} aria-label="Close cart" className="-mr-2 inline-flex h-11 w-11 items-center justify-center text-sm text-zinc-400 transition hover:text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-5 w-5"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <div className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 sm:pr-2">
          {isHydrated && items.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-zinc-700 bg-zinc-900/70 p-8 text-center text-zinc-400">
              <p className="text-lg text-white">Your cart is currently empty.</p>
              <p className="mt-3">Add products to begin building an order.</p>
              <Link
                href="/products"
                onClick={closeCart}
                className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-6 py-3 text-sm"
              >
                Browse products
              </Link>
            </div>
          ) : (
              <div className="space-y-3 sm:space-y-4">
              {items.map((item) => {
                const activeRate = bundleDiscountRate(item.quantity, bundleConfig);
                const nextTier = getNextBundleTier(item.quantity, bundleConfig);
                const lineTotal = getBundleDiscountedLineTotal(item.price, item.quantity, bundleConfig);
                const fullTotal = item.price * item.quantity;
                return (
                <div key={item.key} className="vl-panel-soft rounded-[1.25rem] p-3.5 sm:p-4">
                  <div className="flex gap-3 items-start justify-between mb-3">
                    {/* Product image */}
                    <div className="relative h-14 w-14 flex-shrink-0 rounded-lg border border-zinc-700 bg-zinc-950/50 overflow-hidden flex items-center justify-center sm:h-16 sm:w-16">
                      {item.image ? (
                        <Image src={item.image} alt={item.name} fill sizes="64px" className="h-full w-full object-cover" />
                      ) : (
                        <div className="text-xs text-zinc-500">No image</div>
                      )}
                    </div>

                    <div className="flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-xs font-semibold text-white sm:text-sm">{item.name}</h3>
                          <p className="mt-1 text-xs text-zinc-400">{item.doseLabel ? `${item.doseLabel}${item.batchNumber ? " • " : ""}` : ""}{item.batchNumber ? `Batch ${item.batchNumber}` : ""}</p>
                          {activeRate > 0 ? (
                            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-amber-200/30 bg-amber-200/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                              Bundle · {Math.round(activeRate * 100)}% off applied
                            </span>
                          ) : null}
                        </div>
                        <button type="button" onClick={() => removeFromCart(item.key)} aria-label={`Remove ${item.name} from cart`} className="-my-1 flex-shrink-0 px-1 py-2 text-xs text-zinc-500 transition hover:text-rose-300">
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center rounded-full border border-zinc-700 bg-zinc-950/40 text-sm text-zinc-200">
                      <button type="button" onClick={() => updateQuantity(item.key, item.quantity - 1)} className="inline-flex h-10 w-10 items-center justify-center rounded-l-full text-base transition hover:bg-white/5 hover:text-white active:bg-white/10" aria-label={`Decrease ${item.name} quantity`}>−</button>
                      <span className="min-w-7 text-center text-sm font-semibold tabular-nums">{item.quantity}</span>
                      <button type="button" onClick={() => updateQuantity(item.key, item.quantity + 1)} className="inline-flex h-10 w-10 items-center justify-center rounded-r-full text-base transition hover:bg-white/5 hover:text-white active:bg-white/10" aria-label={`Increase ${item.name} quantity`}>+</button>
                    </div>
                    <div className="text-right">
                      {activeRate > 0 ? (
                        <p className="text-[11px] text-zinc-500 line-through tabular-nums">{formatCartCurrency(fullTotal)}</p>
                      ) : null}
                      <p className="text-sm font-semibold text-white tabular-nums">{formatCartCurrency(lineTotal)}</p>
                    </div>
                  </div>

                  {nextTier ? (
                    <button
                      type="button"
                      onClick={() => updateQuantity(item.key, item.quantity + nextTier.addMore)}
                      className="mt-3 flex w-full items-center justify-between rounded-xl border border-amber-200/25 bg-gradient-to-r from-amber-200/[0.10] via-amber-200/[0.04] to-transparent px-3 py-2 text-left transition hover:border-amber-200/50 hover:from-amber-200/[0.16]"
                    >
                      <span className="text-xs text-amber-100/90">
                        Buy <span className="font-semibold text-amber-200">{nextTier.addMore} more</span> → <span className="font-semibold text-amber-200">{nextTier.percent}% off</span> every unit
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-200">Add</span>
                    </button>
                  ) : null}
                </div>
                );
              })}
            </div>
          )}

          {/* Everything below scrolls WITH the items — on small screens the
              old layout pinned all of this under the list, pushing the
              checkout button off-screen (the mobile "checkout does nothing"
              bug: the button was unreachable). Only the compact total + CTA
              footer stays fixed now. */}
          {isHydrated && items.length > 0 ? (
          <div className="mt-4 space-y-3 border-t border-zinc-800 pt-4 sm:space-y-4">
          {/* BAC Water quick-add — tick to add a size, untick to remove it */}
          <BacWaterCartCheckboxes />

          {/* Buy 3 Get 1 Free Promotion - Show when 3+ items in cart */}
          {isBuy3Get1FreeEligible && (
            <div className="rounded-[1.25rem] border border-amber-200/30 bg-gradient-to-r from-amber-200/[0.12] via-amber-200/[0.05] to-transparent p-4">
              <p className="text-sm font-semibold text-amber-200 flex items-center gap-2">
                🎁 Buy 3 Get 1 Free Active
              </p>
              <p className="text-xs text-amber-100/80 mt-2">
                Lowest-priced eligible item is free.
              </p>
              <p className="text-xs text-amber-100/55 mt-1">
                Referral discounts are disabled while this promotion is active.
              </p>
            </div>
          )}

          {/* Nudge: how many more items unlock the next free one */}
          {buy3Get1UntilNextFree > 0 && (
            <div className="vl-panel-soft rounded-[1.25rem] p-4">
              <p className="text-sm text-zinc-200">
                🎁 Add <span className="font-semibold text-amber-200">{buy3Get1UntilNextFree} more {buy3Get1UntilNextFree === 1 ? "item" : "items"}</span> to unlock a <span className="font-semibold text-amber-200">FREE item</span>.
              </p>
            </div>
          )}

          {showMembershipUpsell && upsellTier && membershipValue ? (
            <Link
              href="/membership"
              onClick={closeCart}
              className="block rounded-[1.25rem] border border-emerald-400/25 bg-gradient-to-r from-emerald-400/[0.10] via-emerald-400/[0.04] to-transparent p-4 transition hover:border-emerald-400/50"
            >
              <p className="text-sm font-semibold text-emerald-300">
                You could save {formatCartCurrency(membershipValue.totalBenefit)} today with {upsellTier.name}
              </p>
              <p className="mt-1 text-xs text-emerald-100/60">
                {formatCartCurrency(membershipValue.discountSavings)} off this cart
                {membershipValue.shippingSavings > 0 ? ` + free shipping (${formatCartCurrency(membershipValue.shippingSavings)})` : ""}
                {membershipValue.monthlyStoreCredit > 0 ? ` + ${formatCartCurrency(membershipValue.monthlyStoreCredit)} monthly credit` : ""}
                {" "}— membership {formatCartCurrency(membershipValue.monthlyCost)}/mo. Join now →
              </p>
            </Link>
          ) : null}

          {bulkSavingsApplied && (
            <div className="rounded-[1.25rem] border border-amber-700 bg-amber-950/40 p-4">
              <p className="text-sm font-semibold text-amber-300">
                Congratulations! Your exclusive member bulk discount has been applied.
              </p>
              <p className="text-xs text-amber-200/80 mt-1">{bulkSavingsPercent}% off this order.</p>
            </div>
          )}

          {!bulkSavingsApplied && bulkSavingsProgress && (
            <div className="vl-panel-soft rounded-[1.25rem] p-4">
              <p className="text-sm text-zinc-300">
                You&apos;re only {formatCartCurrency(bulkSavingsProgress.amountRemaining)} away from unlocking{" "}
                {bulkSavingsProgress.nextPercent}% OFF your order.
              </p>
            </div>
          )}

          {/* Referral Code Section - Only show if buy 3 get 1 free is NOT active */}
          {!isBuy3Get1FreeEligible && (
            <label className="block text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Referral code</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={effectiveReferralInput}
                  onChange={(event) => setReferralInput(event.target.value)}
                  placeholder="VANTA10"
                  className="vl-input flex-1 rounded-full px-4 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => applyReferralCode(effectiveReferralInput)}
                  disabled={isApplyingReferral}
                  className="vl-btn-secondary vl-focus-ring rounded-full px-4 py-3 text-sm disabled:opacity-60"
                >
                  {isApplyingReferral ? "Applying…" : "Apply"}
                </button>
              </div>
            </label>
          )}
          {referralSuccess ? <p className="text-sm text-emerald-400">{referralSuccess}</p> : null}
          {referralError ? <p className="text-sm text-rose-400">{referralError}</p> : null}
          {referralDetails ? (
            <p className="flex items-center justify-between text-sm text-zinc-300">
              <span>Ambassador {referralDetails.ambassadorName} • {referralDetails.customerDiscountPercent}% off</span>
              <button type="button" onClick={clearReferralCode} className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">Remove</button>
            </p>
          ) : null}

          {/* Coupon Code — a separate field from the referral code. Also hidden
              while Buy 3 Get 1 is active (codes can't combine with it). */}
          {!isBuy3Get1FreeEligible && (
            <label className="block text-sm text-zinc-400">
              <span className="mb-2 block uppercase tracking-[0.3em]">Coupon code</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={effectiveCouponInput}
                  onChange={(event) => setCouponInput(event.target.value)}
                  placeholder="LAUNCH"
                  className="vl-input flex-1 rounded-full px-4 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={() => applyCouponCode(effectiveCouponInput)}
                  disabled={isApplyingCoupon}
                  className="vl-btn-secondary vl-focus-ring rounded-full px-4 py-3 text-sm disabled:opacity-60"
                >
                  {isApplyingCoupon ? "Applying…" : "Apply"}
                </button>
              </div>
            </label>
          )}
          {couponSuccess ? <p className="text-sm text-emerald-400">{couponSuccess}</p> : null}
          {couponError ? <p className="text-sm text-rose-400">{couponError}</p> : null}
          {couponDetails ? (
            <p className="flex items-center justify-between text-sm text-zinc-300">
              <span>
                Coupon {couponDetails.code} • {couponDetails.discountType === "fixed" ? formatCartCurrency(couponDetails.discountValue) : `${couponDetails.discountValue}%`} off
              </span>
              <button type="button" onClick={clearCouponCode} className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">Remove</button>
            </p>
          ) : null}
          {subtotal > 0 && (
            <div className="vl-panel-soft rounded-[1.25rem] p-4">
              {shippingProgress.isEligibleForFreeShipping ? (
                <div className="text-center">
                  <p className="text-sm font-semibold text-emerald-400 flex items-center justify-center gap-2">
                    🎉 Congratulations, you&apos;ve unlocked free shipping!
                  </p>
                  <div className="mt-3 w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-300"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-zinc-400">Free shipping at {formatCartCurrency(freeShipThreshold)}</span>
                    <span className="text-white font-semibold">${shippingProgress.amountToFreeShipping.toFixed(2)} more</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-zinc-200 to-zinc-400 transition-all duration-300"
                      style={{ width: `${shippingProgress.progressPercentage}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 mt-2">{Math.round(shippingProgress.progressPercentage)}% to free shipping</p>
                </div>
              )}
            </div>
          )}

          {subtotal > 0 ? (
            <label className="vl-panel-soft flex cursor-pointer items-start justify-between gap-3 rounded-[1.25rem] p-4">
              <span className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={shippingProtectionEnabled}
                  onChange={(e) => setShippingProtectionEnabled(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-emerald-500"
                  aria-label="Add shipping protection"
                />
                <span className="text-sm">
                  <span className="block font-medium text-white">Shipping Protection <span className="font-normal text-emerald-300">(Recommended)</span> <span className="font-normal text-zinc-500">· optional, untick to remove</span></span>
                  <span className="block text-xs text-zinc-500">Store-backed: we&apos;ll replace or refund items lost, stolen, or damaged in transit. <a href="/legal/shipping" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-zinc-300">See terms</a></span>
                </span>
              </span>
              <span className="whitespace-nowrap text-sm text-zinc-300">+{formatCartCurrency(calculateShippingProtectionFee(subtotal))}</span>
            </label>
          ) : null}

          <div className="vl-panel-soft rounded-[1.25rem] p-4 text-sm text-zinc-300">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{formatCartCurrency(subtotal)}</span>
            </div>
            <div className="mt-2 flex justify-between">
              <span>Shipping</span>
              <span>{formatCartCurrency(shipping)}</span>
            </div>
            {discountAmount > 0 ? (
              <div className="mt-2 flex justify-between text-emerald-400">
                <span>{appliedDiscountLabel ?? "You saved"}</span>
                <span>-{formatCartCurrency(discountAmount)}</span>
              </div>
            ) : null}
            {autoBestDiscountApplied ? (
              <p className="mt-2 text-xs text-emerald-300/80">
                ✓ We&apos;ve automatically applied your best available discount. Only one discount applies per order.
              </p>
            ) : null}
            {shippingProtectionFee > 0 ? (
              <div className="mt-2 flex justify-between">
                <span>Shipping protection</span>
                <span>+{formatCartCurrency(shippingProtectionFee)}</span>
              </div>
            ) : null}
            {/* On the express path shipping and tax are finalised inside the
                Apple Pay sheet, not on a later page — "at checkout" would read
                as "tapping Apple Pay skips tax". */}
            <div className="mt-2 flex justify-between text-white/40">
              {showExpressSlot ? (
                <span>Shipping &amp; sales tax — calculated at payment</span>
              ) : (
                <>
                  <span>Sales tax</span>
                  <span>Calculated at checkout</span>
                </>
              )}
            </div>
          </div>
          </div>
          ) : null}
        </div>

        {/* Sticky footer: always visible, safe-area padded, so the checkout
            CTA can never scroll out of reach on a phone. */}
        {isHydrated && items.length > 0 ? (
        <div className="mt-3 border-t border-zinc-800 pt-3 pb-[max(env(safe-area-inset-bottom),0.25rem)]">
          <div className="flex items-baseline justify-between pb-2.5">
            <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Total</span>
            <span className="text-xl font-semibold text-white tabular-nums">{formatCartCurrency(total)}</span>
          </div>
          {/* Shipping protection is a paid add-on that defaults ON, and its
              toggle lives up in the SCROLLING region — on a phone the express
              button is reachable with no scrolling and the opt-out is not. This
              line makes the charge, and the way out of it, visible right where
              the shopper is about to pay. It is also its own labelled row in
              the Apple Pay sheet. */}
          {showExpressSlot && shippingProtectionFee > 0 ? (
            <p className="flex items-center justify-between pb-2.5 text-xs text-zinc-400">
              <span>Shipping protection +{formatCartCurrency(shippingProtectionFee)}</span>
              <button
                type="button"
                onClick={() => setShippingProtectionEnabled(false)}
                className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              >
                Remove
              </button>
            </p>
          ) : null}
          <div className="space-y-2.5">
            {/* Apple Pay express slot. Renders the real native sheet — the
                button only appears once the platform, the registered host, the
                required confirmations and a live server session all check out,
                so a shopper never taps something that can't complete. */}
            {showExpressSlot ? (
              <>
                <p className="text-center text-[10px] uppercase tracking-[0.22em] text-zinc-500">Express checkout</p>

                {/* Required confirmations. The summary row and the pay button
                    are BOTH always visible; the expanded copy gets its own
                    capped scroller so it can never push the button off-screen
                    (the mobile "checkout does nothing" failure this file
                    already memorialises above). */}
                <div className="rounded-[1.25rem] border border-zinc-800 bg-zinc-900/60">
                  <button
                    type="button"
                    onClick={() => setConfirmationsOpen((open) => !open)}
                    aria-expanded={confirmationsOpen}
                    className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
                  >
                    <span className="text-xs text-zinc-300">Required confirmations</span>
                    <span className="flex items-center gap-2">
                      <span className={`text-xs tabular-nums ${allAcknowledged ? "text-emerald-400" : "text-zinc-500"}`}>
                        {acknowledgedCount} of {REQUIRED_CONFIRMATIONS.length}
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                        {confirmationsOpen ? "Hide" : "Review"}
                      </span>
                    </span>
                  </button>
                  {confirmationsOpen ? (
                    <div className="max-h-[45vh] space-y-3 overflow-y-auto overscroll-contain border-t border-zinc-800 px-3.5 py-3">
                      {REQUIRED_CONFIRMATIONS.map((item) => (
                        <label key={item.key} className="flex items-start gap-2.5 text-xs text-zinc-400">
                          <input
                            type="checkbox"
                            checked={acknowledgements[item.key]}
                            onChange={(event) =>
                              setAcknowledgements((current) => ({ ...current, [item.key]: event.target.checked }))
                            }
                            className="mt-0.5 h-4 w-4 accent-emerald-500"
                          />
                          <span>
                            <span className="block text-white">{item.title}</span>
                            <span className="mt-1 block leading-relaxed text-zinc-500">{item.body}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div onClickCapture={() => { if (!allAcknowledged) setConfirmationsOpen(true); }}>
                  <ExpressApplePayButton
                    acknowledged={allAcknowledged}
                    acknowledgements={acknowledgements}
                    onUnavailable={onUnavailable}
                  />
                </div>

                <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-zinc-600">
                  <span className="h-px flex-1 bg-zinc-800" />or<span className="h-px flex-1 bg-zinc-800" />
                </div>
              </>
            ) : null}
            <button
              type="button"
              onClick={handleContinueToCheckout}
              className="vl-btn-primary vl-focus-ring w-full px-4 py-3 text-center text-sm"
            >
              Proceed to checkout
            </button>
            {referralCode ? (
              <button
                type="button"
                onClick={() => {
                  clearReferralCode();
                  setReferralInput("");
                }}
                className="vl-btn-secondary vl-focus-ring w-full rounded-full px-4 py-2.5 text-sm"
              >
                Remove code
              </button>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
              {["Visa", "Mastercard", "Amex", "Discover", ...(showExpressSlot ? ["Apple Pay"] : [])].map((brand) => (
                <span key={brand} className="rounded border border-zinc-700 bg-zinc-900/60 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-500">{brand}</span>
              ))}
            </div>
          </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
